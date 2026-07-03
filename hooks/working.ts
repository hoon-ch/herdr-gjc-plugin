/**
 * herdr-agent-state: report GJC "working" to herdr on agent_start.
 *
 * See startup.ts for why every report carries a monotonic `--seq`.
 * No-op outside a herdr pane; best-effort so it never disturbs the agent loop.
 */
export default function (api: { on: (event: string, handler: () => void) => void }) {
	api.on("agent_start", () => {
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
						"working",
						"--custom-status",
						"working",
						"--seq",
						String(Date.now()),
					],
					() => {},
				);
			})
			.catch(() => {});
	});
}
