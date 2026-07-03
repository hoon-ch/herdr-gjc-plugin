/**
 * herdr-agent-state: return GJC to "working" once the `ask` tool resolves.
 *
 * Fires on the `ask` tool result (the user answered); agent_end still owns the
 * final "idle" transition. See startup.ts for the `--seq` rationale.
 * No-op outside a herdr pane.
 */
export default function (api: { on: (event: string, handler: () => void) => void }) {
	api.on("tool_result", () => {
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
