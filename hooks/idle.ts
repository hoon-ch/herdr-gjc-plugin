/**
 * herdr-agent-state: report GJC "idle" to herdr on agent_end.
 *
 * A short heartbeat plus a small post-transition burst keeps the custom herdr
 * source visible even when herdr reconciles panes or reloads state while the
 * pane is idle. No-op outside a herdr pane; best-effort.
 */

import { herdrGjc, isTopLevelSession, type HerdrHookApi } from "./startup";

export default function (api: HerdrHookApi) {
	api.on("agent_end", (_event, context) => {
		if (!isTopLevelSession(context)) return;
		herdrGjc().report("idle");
	});
}
