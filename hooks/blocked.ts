/**
 * herdr-agent-state: report GJC "blocked" to herdr when the `ask` tool runs.
 *
 * The `ask` tool pauses the agent loop waiting for an explicit user decision,
 * which is herdr's "blocked" state. The runtime only invokes this handler for
 * the declared target tool (`ask`). See startup.ts for the `--seq` rationale.
 * No-op outside a herdr pane.
 */
export default function (api: { on: (event: string, handler: () => void) => void }) {
	api.on("tool_call", () => {
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
						"blocked",
						"--custom-status",
						"waiting",
						"--seq",
						String(Date.now()),
					],
					() => {},
				);
			})
			.catch(() => {});
	});
}
