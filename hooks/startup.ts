/**
 * herdr-agent-state: announce GJC to herdr as soon as the session loads, and
 * keep the report alive for the whole session.
 *
 * herdr can temporarily drop a custom source during pane/process reconciliation
 * or server reloads. Reports are therefore refreshed on a short heartbeat and
 * each state transition also schedules a small burst of follow-up reports, so a
 * mid-turn drop is repaired quickly instead of waiting for the next lifecycle
 * edge. Every report carries a strictly increasing seq; herdr ignores stale seqs.
 */

type HerdrState = "idle" | "working" | "blocked";
export type HerdrHookContext = {
	sessionMetadata?: { kind?: "main" | "sub" };
};
export type HerdrHookHandler = (event: unknown, context?: HerdrHookContext) => void | Promise<void>;
export type HerdrHookApi = {
	on(event: string, handler: HerdrHookHandler): void;
};

export function isTopLevelSession(context?: HerdrHookContext): boolean {
	return context?.sessionMetadata?.kind !== "sub";
}
type HerdrResponse = {
	id?: unknown;
	error?: unknown;
	result?: { read?: { text?: string } };
};
interface HerdrGjc {
	state: HerdrState;
	custom: string;
	timer: ReturnType<typeof setInterval> | null;
	burstTimers: ReturnType<typeof setTimeout>[];
	retryTimer: ReturnType<typeof setTimeout> | null;
	retryAttempt: number;
	released: boolean;
	revision: number;
	nextSeq(): number;
	report(state: HerdrState, custom?: string, options?: { burst?: boolean }): void;
	release(): Promise<void>;
	stop(): void;
}

export function herdrRequest(method: string, params: Record<string, unknown>): Promise<HerdrResponse> {
	const socketPath = process.env.HERDR_SOCKET_PATH;
	if (!socketPath) return Promise.reject(new Error("HERDR_SOCKET_PATH is not set"));

	return import("node:net").then(
		({ createConnection }) =>
			new Promise<HerdrResponse>((resolve, reject) => {
				let buffer = "";
				let settled = false;
				const requestId = `herdr-gjc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
				const socket = createConnection(socketPath);
				const finish = (error?: Error, response?: HerdrResponse) => {
					if (settled) return;
					settled = true;
					socket.destroy();
					if (error) reject(error);
					else resolve(response ?? {});
				};

				socket.setEncoding("utf8");
				socket.setTimeout(1500);
				socket.once("connect", () => {
					socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
				});
				socket.on("data", chunk => {
					buffer += String(chunk);
					const newline = buffer.indexOf("\n");
					if (newline < 0) {
						if (buffer.length > 1_048_576) finish(new Error("herdr response exceeded 1 MiB"));
						return;
					}
					if (newline > 1_048_576) {
						finish(new Error("herdr response exceeded 1 MiB"));
						return;
					}
					try {
						const parsed: unknown = JSON.parse(buffer.slice(0, newline));
						if (!parsed || typeof parsed !== "object") {
							finish(new Error("herdr returned invalid JSON"));
							return;
						}
						const response = parsed as HerdrResponse;
						if (response.id !== requestId) {
							finish(new Error("herdr returned a mismatched response"));
							return;
						}
						if (response.error !== undefined && response.error !== null) {
							finish(new Error("herdr rejected the request"));
							return;
						}
						finish(undefined, response);
					} catch {
						finish(new Error("herdr returned invalid JSON"));
					}
				});
				socket.once("timeout", () => finish(new Error("herdr request timed out")));
				socket.once("error", error => finish(error));
				socket.once("close", () => finish(new Error("herdr closed the socket without a response")));
			}),
	);
}

async function reportViaCli(paneId: string, state: HerdrState, custom: string, seq: number): Promise<void> {
	const args = [
		"pane",
		"report-agent",
		paneId,
		"--source",
		"custom:herdr-gjc-plugin",
		"--agent",
		"gjc",
		"--state",
		state,
		"--custom-status",
		custom,
		"--seq",
		String(seq),
	];

	const { execFile } = await import("node:child_process");
	await new Promise<void>((resolve, reject) => {
		execFile("herdr", args, { timeout: 2000 }, error => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function releaseViaCli(paneId: string, seq: number): Promise<void> {
	const { execFile } = await import("node:child_process");
	await new Promise<void>((resolve, reject) => {
		execFile(
			"herdr",
			[
				"pane",
				"release-agent",
				paneId,
				"--source",
				"custom:herdr-gjc-plugin",
				"--agent",
				"gjc",
				"--seq",
				String(seq),
			],
			{ timeout: 2000 },
			error => {
				if (error) reject(error);
				else resolve();
			},
		);
	});
}

export function visibleLooksWorking(text: string): boolean {
	const visibleLines = text.trimEnd().split(/\r?\n/);
	const activeTail = visibleLines.slice(-6).join("\n");
	return /(?:^|\n)\s*[⠁-⣿]\s+\S/.test(activeTail);
}

export function herdrGjc(): HerdrGjc {
	const g = globalThis as unknown as { __herdrGjc?: HerdrGjc; __herdrGjcSeq?: number };
	if (g.__herdrGjc) return g.__herdrGjc;

	const canReport = () => process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID);
	let self: HerdrGjc;
	let latestAttemptSeq = 0;

	const clearRetry = () => {
		self.retryAttempt = 0;
		if (self.retryTimer) {
			clearTimeout(self.retryTimer);
			self.retryTimer = null;
		}
	};
	const scheduleRetry = () => {
		if (self.released || self.retryTimer) return;
		const retryDelays = [250, 1000, 3000, 5000];
		const delay = retryDelays[Math.min(self.retryAttempt, retryDelays.length - 1)];
		self.retryAttempt += 1;
		self.retryTimer = setTimeout(() => {
			self.retryTimer = null;
			reportNow();
		}, delay);
		(self.retryTimer as { unref?: () => void }).unref?.();
	};
	const reportNow = () => {
		void (async () => {
			const paneId = process.env.HERDR_PANE_ID;
			if (self.released || !paneId || process.env.HERDR_ENV !== "1") return;

			const lifecycleState = self.state;
			const lifecycleRevision = self.revision;
			let stateSnapshot = lifecycleState;
			let customSnapshot = self.custom;
			if (lifecycleState === "idle") {
				try {
					const response = await herdrRequest("pane.read", {
						pane_id: paneId,
						source: "visible",
						lines: 45,
						format: "text",
					});
					if (self.released) return;
					if (
						self.revision === lifecycleRevision &&
						visibleLooksWorking(String(response.result?.read?.text ?? ""))
					) {
						stateSnapshot = "working";
						customSnapshot = "working";
					}
				} catch {
					// Keep the lifecycle state when pane inspection is temporarily unavailable.
				}
			}
			if (self.released) return;
			if (self.revision !== lifecycleRevision) return;

			const seq = self.nextSeq();
			latestAttemptSeq = seq;
			const params: Record<string, unknown> = {
				pane_id: paneId,
				source: "custom:herdr-gjc-plugin",
				agent: "gjc",
				state: stateSnapshot,
				custom_status: customSnapshot,
				seq,
			};

			try {
				try {
					await herdrRequest("pane.report_agent", params);
				} catch {
					await reportViaCli(paneId, stateSnapshot, customSnapshot, seq);
				}
				if (seq === latestAttemptSeq) clearRetry();
			} catch {
				if (seq === latestAttemptSeq) scheduleRetry();
			}
		})();
	};

	self = {
		state: "idle",
		custom: "idle",
		timer: null,
		burstTimers: [],
		retryTimer: null,
		retryAttempt: 0,
		released: false,
		revision: 0,
		nextSeq() {
			const now = Date.now();
			const last = g.__herdrGjcSeq ?? 0;
			const seq = now > last ? now : last + 1;
			g.__herdrGjcSeq = seq;
			return seq;
		},
		report(state, custom, options) {
			if (self.released) return;
			self.state = state;
			self.custom = custom ?? state;
			self.revision += 1;
			if (!canReport()) return;

			reportNow();
			if (!self.timer) {
				const ms = Math.max(1000, Number(process.env.HERDR_GJC_HEARTBEAT_MS) || 2000);
				self.timer = setInterval(reportNow, ms);
				(self.timer as { unref?: () => void }).unref?.();
			}
			if (options?.burst !== false) {
				for (const timer of self.burstTimers) clearTimeout(timer);
				self.burstTimers = [1000, 3000].map(delay => {
					const timer = setTimeout(reportNow, delay);
					(timer as { unref?: () => void }).unref?.();
					return timer;
				});
			}
		},
		async release() {
			if (self.released) return;
			self.released = true;
			self.stop();
			const paneId = process.env.HERDR_PANE_ID;
			if (!paneId || process.env.HERDR_ENV !== "1") return;
			const seq = self.nextSeq();
			try {
				try {
					await herdrRequest("pane.release_agent", {
						pane_id: paneId,
						source: "custom:herdr-gjc-plugin",
						agent: "gjc",
						seq,
					});
				} catch {
					await releaseViaCli(paneId, seq);
				}
			} catch {
				// best-effort: never block or fail shutdown on a herdr error
			}
		},
		stop() {
			if (self.timer) {
				clearInterval(self.timer);
				self.timer = null;
			}
			for (const timer of self.burstTimers) clearTimeout(timer);
			self.burstTimers = [];
			clearRetry();
		},
	};
	g.__herdrGjc = self;
	return self;
}

export default function (api: HerdrHookApi) {
	api.on("session_start", (_event, context) => {
		if (!isTopLevelSession(context)) return;
		herdrGjc().report("idle");
	});
}
