/**
 * herdr-agent-state: announce GJC to herdr as soon as the session loads.
 *
 * Without this, herdr only learns about GJC on the first agent_start (first
 * prompt), so a freshly launched idle GJC is invisible in the sidebar. Report
 * "idle" at session load so herdr recognizes the pane immediately.
 *
 * Every report carries a monotonic `--seq` (wall-clock ms): herdr ignores any
 * report whose seq is <= the last one it accepted for this source, so without
 * increasing seqs our reports would be silently dropped. No-op outside herdr.
 */
export default function (api: { on: (event: string, handler: () => void) => void }) {
	api.on("session_start", () => {
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
						"idle",
						"--custom-status",
						"idle",
						"--seq",
						String(Date.now()),
					],
					() => {},
				);
			})
			.catch(() => {});
	});
}
