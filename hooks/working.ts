/**
 * herdr-agent-state: report GJC "working" to herdr on agent_start.
 *
 * A short heartbeat plus a small post-transition burst keeps the custom herdr
 * source visible even when herdr reconciles panes or reloads state mid-turn.
 * No-op outside a herdr pane; best-effort so it never disturbs the agent loop.
 */

import { herdrGjc, isTopLevelSession, type HerdrHookApi } from "./startup";

export default function (api: HerdrHookApi) {
	api.on("agent_start", (_event, context) => {
		if (!isTopLevelSession(context)) return;
		herdrGjc().report("working");
	});
}
