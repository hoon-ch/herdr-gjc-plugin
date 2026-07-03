/**
 * herdr-agent-state: retract GJC from herdr when the session shuts down.
 *
 * Exiting GJC does not close the herdr pane (a shell remains), and custom agent
 * reports have no process binding, so without an explicit retraction herdr
 * keeps showing the last GJC state forever. On shutdown we stop the heartbeat
 * (see startup.ts) and release the custom agent authority so the pane stops
 * advertising a GJC agent — stopping the timer first guarantees no heartbeat
 * report re-adds GJC after the release lands.
 *
 * `release-agent` is seq-gated exactly like reports, so we pass a fresh
 * monotonic `--seq`; otherwise a release older than the last report is ignored.
 *
 * This runs while the process is tearing down, so we call herdr SYNCHRONOUSLY
 * (execFileSync) to guarantee the release lands before the process exits.
 * No-op outside a herdr pane; wrapped so a herdr failure never blocks exit.
 */
import { execFileSync } from "node:child_process";

export default function (api: { on: (event: string, handler: () => void) => void }) {
	api.on("session_shutdown", () => {
		// Stop the shared heartbeat so nothing re-reports GJC after release.
		const g = globalThis as unknown as {
			__herdrGjc?: { timer: ReturnType<typeof setInterval> | null };
		};
		const hb = g.__herdrGjc;
		if (hb?.timer) {
			clearInterval(hb.timer);
			hb.timer = null;
		}

		const paneId = process.env.HERDR_PANE_ID;
		if (process.env.HERDR_ENV !== "1" || !paneId) return;
		try {
			execFileSync(
				"herdr",
				[
					"pane",
					"release-agent",
					paneId,
					"--source",
					"custom:gjc",
					"--agent",
					"gjc",
					"--seq",
					String(Date.now()),
				],
				{ timeout: 3000, stdio: "ignore" },
			);
		} catch {
			// best-effort: never block or fail shutdown on a herdr error
		}
	});
}
