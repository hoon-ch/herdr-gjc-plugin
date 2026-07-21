/**
 * herdr-agent-state: report GJC "working" to herdr on every turn_start.
 *
 * `agent_start` only fires once per user prompt. Autonomous/goal continuation
 * and maintenance-resumed runs keep working through fresh `turn_start` events
 * without a new `agent_start`, so subscribing here re-asserts working for each
 * LLM turn and prevents a completed turn from leaving an actively-working pane
 * stuck idle. Idempotent with working.ts; blocked is set later within the turn
 * by the `ask` tool_call and is not disturbed until a new turn or unblock.
 *
 * No-op outside a herdr pane; best-effort so it never disturbs the agent loop.
 */

import { herdrGjc, isTopLevelSession, type HerdrHookApi } from "./startup";

export default function (api: HerdrHookApi) {
	api.on("turn_start", (_event, context) => {
		if (!isTopLevelSession(context)) return;
		herdrGjc().report("working");
	});
}
