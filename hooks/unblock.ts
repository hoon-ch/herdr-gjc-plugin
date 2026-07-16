/**
 * herdr-agent-state: return GJC to "working" once the `ask` tool resolves.
 *
 * Fires on the `ask` tool result (the user answered); agent_end still owns the
 * final "idle" transition. A short heartbeat plus a small post-transition burst
 * keeps the custom herdr source visible until the next state change.
 */

import { herdrGjc, isTopLevelSession, type HerdrHookApi } from "./startup";

export default function (api: HerdrHookApi) {
	api.on("tool_result", (_event, context) => {
		if (!isTopLevelSession(context)) return;
		herdrGjc().report("working");
	});
}
