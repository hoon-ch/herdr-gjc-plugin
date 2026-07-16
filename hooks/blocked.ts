/**
 * herdr-agent-state: report GJC "blocked" to herdr when the `ask` tool runs.
 *
 * The `ask` tool pauses the agent loop waiting for an explicit user decision.
 * A short heartbeat plus a small post-transition burst keeps the custom herdr
 * source visible until the state changes. No-op outside a herdr pane.
 */

import { herdrGjc, isTopLevelSession, type HerdrHookApi } from "./startup";

export default function (api: HerdrHookApi) {
	api.on("tool_call", (_event, context) => {
		if (!isTopLevelSession(context)) return;
		herdrGjc().report("blocked", "waiting");
	});
}
