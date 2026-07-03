/**
 * herdr-agent-state: report GJC "idle" to herdr on agent_end.
 *
 * Fires when the agent loop finishes and control returns to the user.
 * See startup.ts for why every report carries a monotonic `--seq`.
 * No-op outside a herdr pane; best-effort.
 */
export default function (api: { on: (event: string, handler: () => void) => void }) {
	api.on("agent_end", () => {
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
