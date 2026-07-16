/**
 * herdr-agent-state: retract GJC from herdr when the session shuts down.
 *
 * Exiting GJC leaves the herdr pane and shell alive, so a custom lifecycle
 * authority must be released explicitly. The shared reporter stops heartbeat,
 * burst, and retry timers first, then waits for an acknowledged socket release.
 * It falls back to the herdr CLI when the socket is unavailable.
 */
import { herdrGjc, isTopLevelSession, type HerdrHookApi } from "./startup";

export default function (api: HerdrHookApi) {
	api.on("session_shutdown", async (_event, context) => {
		if (!isTopLevelSession(context)) return;
		await herdrGjc().release();
	});
}
