/**
 * herdr-agent-state: announce GJC to herdr as soon as the session loads, and
 * install the heartbeat that keeps the report alive for the whole session.
 *
 * Without this, herdr only learns about GJC on the first agent_start (first
 * prompt), so a freshly launched idle GJC is invisible in the sidebar. Report
 * "idle" at session load so herdr recognizes the pane immediately.
 *
 * WHY THE HEARTBEAT: our reports are edge-triggered (one per state change).
 * A custom source is not a herdr lifecycle-authority integration, so herdr may
 * drop it during a long turn when its detection pass reconciles the pane or the
 * server reloads manifests — and nothing re-asserts it until the next state
 * change (agent_end -> idle), which is exactly why GJC vanishes from the Agents
 * list mid-task and only reappears once the work finishes. herdr's own docs
 * tell integrations to refresh periodically. The shared singleton below
 * re-sends the current state every HERDR_GJC_HEARTBEAT_MS (default 15s), so any
 * transient loss self-heals within one interval instead of lasting the task.
 *
 * Every report carries a monotonic `--seq` (wall-clock ms): herdr ignores any
 * report whose seq is <= the last one it accepted for this source, so without
 * increasing seqs our reports would be silently dropped. No-op outside herdr.
 */

// Shared, idempotent singleton. Installer copies only manifest-declared files,
// so hooks cannot import a common module — each hook carries this same helper
// and coordinates through globalThis (all hooks load in one process).
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
	api.on("session_start", () => {
		herdrGjc().report("idle");
	});
}
