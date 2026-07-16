# Repository Guidelines

## Project Overview

`herdr-gjc-plugin` is a validated GJC plugin that reports top-level GJC lifecycle state to Herdr. It makes a Herdr pane show authoritative `idle`, `working`, or `blocked` state without changing the Herdr binary. This repository is the source of truth; installed bundles under `~/.gjc/agent/gjc-plugins/herdr-agent-state/` are generated copies.

## Architecture & Data Flow

1. `gajae-plugin.json` maps GJC events to one hook module each.
2. Small modules in `hooks/` reject in-process subagent events via `isTopLevelSession(context)` and delegate to the shared `herdrGjc()` reporter.
3. `hooks/startup.ts` owns the process-global reporter (`globalThis.__herdrGjc`), state, timers, retries, and monotonic sequence numbers.
4. Before reporting, the reporter validates the public pane ID with `pane.get` and binds it to Herdr's stable `terminal_id`. After a pane move or Herdr restart, `pane.list` re-resolves the current pane by terminal ID. Never restore an unverified stale-pane fallback.
5. Reports use newline-delimited JSON over `HERDR_SOCKET_PATH`; the `herdr` CLI is the compatibility fallback. Idle reports may inspect the visible pane tail to detect active spinner output.
6. `session_shutdown` stops timers and releases the agent authority. All failures are best-effort and must not break the GJC loop or shutdown.

Preserve the concurrency guards: lifecycle `revision`, strictly increasing `seq`, `released` checks after awaits, and newest-attempt-only retry handling prevent stale async work from overwriting current state.

## Key Directories

- `hooks/` — lifecycle adapters and the shared Herdr reporter.
- `tests/` — Bun tests and a local Unix-socket Herdr protocol fixture.
- Repository root — plugin manifest plus Unix/PowerShell install, reinstall, uninstall, and deployment scripts.

## Development Commands

```bash
bun test                         # full suite
bun test tests/startup.test.ts   # focused reporter suite
./install.sh                     # first user-scope install
./reinstall.sh                   # apply manifest/hook edits (--force)
./deploy-all.sh                  # reinstall locally, then configured remotes
./uninstall.sh                   # remove registry entry and installed bundle
```

PowerShell equivalents are `.\install.ps1`, `.\reinstall.ps1`, and `.\uninstall.ps1`. Restart GJC or run `gjc --resume` after installation changes; running sessions keep the plugin version loaded at startup.

There is no separate build step and no repository lint/format configuration. Do not invent package-manager, lint, or coverage commands.

## Code Conventions & Common Patterns

- TypeScript uses tabs, semicolons, double quotes, trailing commas, camelCase values, PascalCase types, and uppercase environment/constants.
- Keep lifecycle files small: a default registration factory, `_event` for an unused payload, a top-level-session guard, then delegation to `herdrGjc()`.
- Keep hook `event`, `target`, and `phase` declarations in `gajae-plugin.json` aligned with module behavior. `blocked`/`unblock` are scoped to the `ask` tool by the manifest.
- Reuse the singleton reporter; never introduce a second socket client, timer owner, or sequence authority.
- Treat canonical lifecycle state separately from a temporary reported snapshot. For example, idle spinner detection may emit `working` without mutating stored idle state.
- Use socket-first/CLI-second async handling, bounded timeouts, acknowledged request IDs, and swallowed best-effort failures. Timers must be stopped on release and `unref()`ed while active.
- Fix attribution by stable terminal identity, not by workspace labels, cwd guesses, or a cached public pane ID.

## Important Files

- `gajae-plugin.json` — plugin name, version, hook paths, events, targets, and phases.
- `hooks/startup.ts` — entry hook, reporter singleton, transport, pane resolution, heartbeat, ordering, and retry logic.
- `hooks/working.ts`, `idle.ts`, `blocked.ts`, `unblock.ts`, `shutdown.ts` — lifecycle-to-state adapters.
- `tests/startup.test.ts` — protocol, activity detection, ordering, shutdown, subagent, and space-binding regressions.
- `deploy-all.sh` — local/remote deployment and installed-version verification.
- `README.md` — supported behavior, installation, and operational caveats.

## Runtime/Tooling Preferences

- Use Bun to execute TypeScript tests (`bun:test`). No `package.json` or separate package installation is required.
- Runtime integration requires `gjc` and Herdr. Production code may dynamically import `node:` built-ins available in the GJC/Bun runtime.
- Unix deployment additionally uses Node, SSH/SCP, and `rsync`; uninstall uses Python 3. Windows workflows use PowerShell.
- Edit only this checkout. Direct edits to the installed, hashed plugin bundle trigger GJC hash-drift quarantine.
- After hook or manifest changes, bump the manifest version when releasing and run the platform reinstall script.
- Do not use `gjc plugin uninstall herdr-agent-state`; use the repository uninstall script because local-bundle registry entries otherwise remain.

## Testing & QA

Tests use `bun:test` with real timers and a temporary newline-delimited JSON Unix socket. `startServer()` records requests and supports method-specific responses; `registeredHandler()` captures hook registrations; `resetReporter()` and `afterEach` restore singleton, socket, temporary files, and environment variables.

For new behavior:

- Use `{ burst: false }` in direct reporter tests to avoid transition-timer noise.
- Preserve request IDs in socket responses and assert filtered `pane.report_agent`/`pane.release_agent` requests.
- Test observable state, absence of stale reports, error paths, and ordering races with asymmetric delays.
- For pane movement, establish `terminal_id`, invalidate the old pane, resolve through `pane.list`, and cover the unmatched-terminal fail-closed path.
- Run the focused test during iteration and `bun test` before completion. No numeric coverage threshold is configured.
