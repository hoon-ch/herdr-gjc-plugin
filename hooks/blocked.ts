/**
 * herdr-agent-state: report GJC "blocked" to herdr when the `ask` tool runs.
 *
 * The `ask` tool pauses the agent loop waiting for an explicit user decision.
 * A short heartbeat plus a small post-transition burst keeps the custom herdr
 * source visible until the state changes. No-op outside a herdr pane.
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
						execFile(
							"herdr",
							[
								"pane",
								"report-agent",
								paneId,
								"--source",
								"custom:gjc",
								"--agent",
								"gjc",
								"--state",
								stateSnapshot,
								"--custom-status",
								customSnapshot,
								"--seq",
								String(seq),
							],
							() => {},
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
	api.on("tool_call", () => {
		herdrGjc().report("blocked", "waiting");
	});
}
