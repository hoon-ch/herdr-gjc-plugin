# herdr-gjc-plugin

A [GJC (Gajae Code)](https://github.com/Yeachan-Heo/gajae-code) plugin that reports the
agent's lifecycle to [herdr](https://herdr.dev) so a GJC pane shows real
`idle` / `working` / `blocked` state in the herdr sidebar.

## Why

herdr has no native detection for GJC — it is not in herdr's supported-agent
list, and adding new process detection requires a herdr binary update. The
public GJC build also quarantines filesystem hook/extension discovery, so
`--hook` and `~/.gjc/agent/hooks/` are ignored.

The one extensibility surface that still loads in the public binary is the
**validated GJC plugin** (`loadConstrainedPluginHooks`). This plugin uses it to
send lifecycle state over herdr's local socket API (`pane.report_agent` /
`pane.release_agent`). Reports wait for a socket acknowledgement, fall back to
the `herdr` CLI for compatibility, and never use the denied plugin `exec` API.

## State mapping

| GJC hook event            | herdr call                                | Result                         |
| ------------------------- | ----------------------------------------- | ------------------------------ |
| `session_start`           | `report-agent --state idle`               | Pane recognized as GJC on launch |
| `agent_start`             | `report-agent --state working`            | working                        |
| `tool_call` (target `ask`)| `report-agent --state blocked`            | blocked / `waiting`            |
| `tool_result` (target `ask`)| `report-agent --state working`          | back to working after answer   |
| `agent_end`               | `report-agent --state idle`               | idle                           |
| `session_shutdown`        | acknowledged `release-agent`               | GJC removed from herdr on exit |

Every reported state is also **refreshed on a heartbeat** while the session is
alive (default every 2s, override with `HERDR_GJC_HEARTBEAT_MS`). Each state
transition also sends a short follow-up burst at 1s and 3s. Delivery is
acknowledged over `HERDR_SOCKET_PATH`; responses must carry the matching request
ID and are capped at 1 MiB. A failed socket/CLI delivery is retried after 250ms
with bounded backoff instead of being silently discarded.

herdr can drop a custom lifecycle source when its pane/process reconciliation
runs or the server reloads manifests. The heartbeat repairs a report that was
accepted earlier and later evicted; the acknowledgement retry repairs a report
that never arrived. When GJC has fired `idle` while the visible UI still shows
live work, the heartbeat reads the visible pane and recognizes an active spinner
near the prompt. Token-rate HUD values are intentionally ignored because the
last completed turn leaves them visible at the idle prompt. Activity must appear
in the bottom six lines, so stale progress higher in the scrollback does not keep
an actually idle pane marked `working`. Lifecycle revisions prevent a
slow pane read from overwriting a newer state, and shutdown suppresses in-flight
reports before releasing the source. All lifecycle hooks share one reporter
through `globalThis`.
In-process subagent sessions are ignored via GJC's `sessionMetadata.kind`; their
startup/shutdown events must not overwrite or release the parent pane's source.

Notes:

- Every report carries a strictly increasing `--seq` (wall-clock ms, bumped when
  multiple reports happen in the same millisecond). herdr ignores any
  report whose seq is `<=` the last accepted seq for the source, so without
  increasing seqs reports would be silently dropped.
- Hooks are a no-op outside a herdr pane (guarded on `HERDR_ENV` /
  `HERDR_PANE_ID`) and every herdr call is best-effort — a herdr failure never
  disturbs or blocks the agent.
- `session_shutdown` fires on graceful exits (Ctrl+D, `/exit`, Ctrl+C). A hard
  kill (SIGKILL) cannot run it; herdr keeps the last state until the pane closes.
- `blocked` is signaled only by the `ask` tool (the explicit "waiting on user"
  case); GJC has no dedicated approval/permission event.

## Install

```bash
./install.sh
# or: gjc plugin install --local ~/repos/herdr-gjc-plugin --user
```

```powershell
.\install.ps1
# or: gjc plugin install --local $PWD --user
```

Restart GJC (or `gjc --resume`) after installing so the plugin loads. Plugins
load at session start; an already-running session is not affected until restart.

## Update after editing

Edit the source in this repo, then reinstall:

```bash
./reinstall.sh
# or: gjc plugin install --local ~/repos/herdr-gjc-plugin --user --force
```

```powershell
.\reinstall.ps1
# or: gjc plugin install --local $PWD --user --force
```

To deploy the current tree to private SSH hosts without committing hostnames,
create a gitignored `.deploy-targets` file:

```text
unix this-machine-ssh-alias self
unix my-other-mac-or-linux-host
windows my-windows-host
```

Each machine can keep its own private `.deploy-targets`; synced deployments
exclude that file. Mark the current machine with `self` when you keep a shared
personal target list locally. `deploy-all.sh` always reinstalls locally, skips
`self` entries, and with no `.deploy-targets` present it does a local-only
reinstall.

Then run:

```bash
./deploy-all.sh
```

`install` copies the validated, hashed files into the user GJC plugin directory
(`~/.gjc/agent/gjc-plugins/herdr-agent-state/` on Unix-like systems,
`$HOME\.gjc\agent\gjc-plugins\herdr-agent-state\` on Windows), so this repo is
the source of truth and the installed copy runs independently.

## Uninstall

```bash
./uninstall.sh
```

```powershell
.\uninstall.ps1
```

Do **not** rely on `gjc plugin uninstall herdr-agent-state` — see Caveats.

## Scripts

| Script                         | What it does                                                        |
| ------------------------------ | ------------------------------------------------------------------- |
| `install.sh` / `install.ps1`     | `gjc plugin install --local <repo> --user` (first install)          |
| `reinstall.sh` / `reinstall.ps1` | same with `--force` (apply edits)                                   |
| `deploy-all.sh`                  | reinstalls locally, syncs gitignored `.deploy-targets`, verifies remotes     |
| `uninstall.sh` / `uninstall.ps1` | removes the bundle directly (registry entry + installed dir)        |

## Caveats

1. **Restart to (un)load.** GJC loads plugins at session start. Install,
   reinstall, and uninstall only affect sessions started afterwards; a running
   session keeps whatever it loaded until you restart it (or `gjc --resume`).

2. **Never edit the installed copy.** The installed tree under the user GJC
   plugin directory is hashed at install time. Editing it directly triggers a
   hash-drift quarantine and the hooks stop loading. Always edit here in the repo
   and run `./reinstall.sh` or `.\reinstall.ps1`.

3. **`gjc plugin uninstall` does not remove this plugin.** `gjc plugin install
   --local` uses GJC's plugin-bundle installer, but `gjc plugin uninstall` only
   handles marketplace/npm plugins — it prints `✔ Uninstalled` without touching
   the GJC-bundle registry (`~/.gjc/agent/gjc-plugins/registry.json`, or
   `$HOME\.gjc\agent\gjc-plugins\registry.json` on Windows) or the installed
   files. Use `./uninstall.sh` or `.\uninstall.ps1`, which deletes the registry
   entry and the installed directory itself. (Observed on GJC 0.7.10.)

4. **Hard kill leaves stale state.** `session_shutdown` fires on graceful exits
   (Ctrl+D, `/exit`, Ctrl+C). A `SIGKILL`/crash cannot run it, so herdr keeps
   the last reported state until the pane closes.

## Layout

```
gajae-plugin.json     # plugin manifest (kind: gajae-code-plugin, hooks[])
hooks/
  startup.ts          # session_start   -> idle
  working.ts          # agent_start     -> working
  blocked.ts          # tool_call/ask   -> blocked
  unblock.ts          # tool_result/ask -> working
  idle.ts             # agent_end       -> idle
  shutdown.ts         # session_shutdown-> release-agent
tests/
  startup.test.ts       # activity, ordering, and shutdown race regressions
install.sh  reinstall.sh  uninstall.sh
install.ps1 reinstall.ps1 uninstall.ps1
```
