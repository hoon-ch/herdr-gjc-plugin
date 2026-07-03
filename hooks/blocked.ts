/**
 * herdr-agent-state: report GJC "blocked" to herdr when the `ask` tool runs.
 *
 * The `ask` tool pauses the agent loop waiting for an explicit user decision,
 * which is herdr's "blocked" state. The runtime only invokes this handler for
 * the declared target tool (`ask`). The shared heartbeat singleton (see
 * startup.ts) keeps re-sending "blocked"/"waiting" until the state changes.
 * No-op outside a herdr pane.
 */
type HerdrState = "idle" | "working" | "blocked";
interface HerdrGjc {
	state: HerdrState;
	custom: string;
	timer: ReturnType<typeof setInterval> | null;
	report(state: HerdrState, custom?: string): void;
	stop(): void;
}
function herdrGjc(): HerdrGjc {
	const g = globalThis as unknown as { __herdrGjc?: HerdrGjc };
	if (g.__herdrGjc) return g.__herdrGjc;
	const self: HerdrGjc = {
		state: "idle",
		custom: "idle",
		timer: null,
		report(state, custom) {
			self.state = state;
			self.custom = custom ?? state;
			const paneId = process.env.HERDR_PANE_ID;
			if (process.env.HERDR_ENV !== "1" || !paneId) return;
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
							self.state,
							"--custom-status",
							self.custom,
							"--seq",
							String(Date.now()),
						],
						() => {},
					);
				})
				.catch(() => {});
			if (!self.timer) {
				const ms = Number(process.env.HERDR_GJC_HEARTBEAT_MS) || 15000;
				self.timer = setInterval(() => self.report(self.state, self.custom), ms);
				(self.timer as { unref?: () => void }).unref?.();
			}
		},
		stop() {
			if (self.timer) {
				clearInterval(self.timer);
				self.timer = null;
			}
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
