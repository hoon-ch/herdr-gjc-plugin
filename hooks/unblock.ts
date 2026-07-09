/**
 * herdr-agent-state: return GJC to "working" once the `ask` tool resolves.
 *
 * Fires on the `ask` tool result (the user answered); agent_end still owns the
 * final "idle" transition. A short heartbeat plus a small post-transition burst
 * keeps the custom herdr source visible until the next state change.
 */

type HerdrState = "idle" | "working" | "blocked";
interface HerdrGjc {
	state: HerdrState;
	custom: string;
	timer: ReturnType<typeof setInterval> | null;
	burstTimers: ReturnType<typeof setTimeout>[];
	nextSeq(): number;
	report(state: HerdrState, custom?: string, options?: { burst?: boolean }): void;
	stop(): void;
}

function herdrGjc(): HerdrGjc {
	const g = globalThis as unknown as { __herdrGjc?: HerdrGjc; __herdrGjcSeq?: number };
	if (g.__herdrGjc) return g.__herdrGjc;

	const canReport = () => process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID);
	const visibleLooksWorking = (text: string) => {
		const visibleTail = text.split(/\r?\n/).slice(-45).join("\n");
		return /(?:^|\n)\s*[⠁-⣿]\s+Awaiting .*worker/.test(visibleTail) || /─\s*⤴\s*\d+(?:\.\d+)?\/s\b/.test(visibleTail);
	};
	const self: HerdrGjc = {
		state: "idle",
		custom: "idle",
		timer: null,
		burstTimers: [],
		nextSeq() {
			const now = Date.now();
			const last = g.__herdrGjcSeq ?? 0;
			const seq = now > last ? now : last + 1;
			g.__herdrGjcSeq = seq;
			return seq;
		},
		report(state, custom, options) {
			self.state = state;
			self.custom = custom ?? state;
			if (!canReport()) return;

			const reportNow = () => {
				const paneId = process.env.HERDR_PANE_ID;
				if (!paneId || process.env.HERDR_ENV !== "1") return;
				const stateSnapshot = self.state;
				const customSnapshot = self.custom;
				const seq = self.nextSeq();
				import("node:child_process")
					.then(({ execFile }) => {
						const report = (reportedState: HerdrState, reportedCustom: string) => {
							execFile(
								"herdr",
								[
									"pane",
									"report-agent",
									paneId,
									"--source",
									"custom:herdr-gjc-plugin",
									"--agent",
									"gjc",
									"--state",
									reportedState,
									"--custom-status",
									reportedCustom,
									"--seq",
									String(seq),
								],
								() => {},
							);
						};

						if (stateSnapshot !== "idle") {
							report(stateSnapshot, customSnapshot);
							return;
						}

						execFile(
							"herdr",
							["pane", "read", paneId, "--source", "visible", "--lines", "45", "--format", "text"],
							{ timeout: 1500 },
							(error, stdout) => {
								if (!error && visibleLooksWorking(String(stdout))) {
									report("working", "working");
									return;
								}
								report(stateSnapshot, customSnapshot);
							},
						);
					})
					.catch(() => {});
			};

			reportNow();
			if (!self.timer) {
				const ms = Math.max(1000, Number(process.env.HERDR_GJC_HEARTBEAT_MS) || 5000);
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
		stop() {
			if (self.timer) {
				clearInterval(self.timer);
				self.timer = null;
			}
			for (const timer of self.burstTimers) clearTimeout(timer);
			self.burstTimers = [];
		},
	};
	g.__herdrGjc = self;
	return self;
}

export default function (api: { on: (event: string, handler: () => void) => void }) {
	api.on("tool_result", () => {
		herdrGjc().report("working");
	});
}
