/**
 * herdr-agent-state: report GJC "idle" to herdr on agent_end.
 *
 * agent_end carries the authoritative reason the loop ended. Only a completed
 * or cancelled loop is truly idle. `paused` means the loop suspended and will
 * resume (steering/continuation, or a headless ask gate), and `maintenance`
 * means auto-compaction is running and the run resumes afterwards — neither is
 * idle, so we leave the current state (working/blocked) in place and let the
 * heartbeat keep it visible. This replaces the old visible-pane spinner scrape.
 *
 * A short heartbeat plus a small post-transition burst keeps the custom herdr
 * source visible even when herdr reconciles panes or reloads state while the
 * pane is idle. No-op outside a herdr pane; best-effort.
 */

import { herdrGjc, isTopLevelSession, type HerdrHookApi } from "./startup";

type AgentEndEvent = { stopReason?: "completed" | "paused" | "cancelled" | "maintenance" };

export default function (api: HerdrHookApi) {
	api.on("agent_end", (event, context) => {
		if (!isTopLevelSession(context)) return;
		const stopReason = (event as AgentEndEvent | undefined)?.stopReason;
		if (stopReason === "paused" || stopReason === "maintenance") return;
		herdrGjc().report("idle");
	});
}
