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
push lifecycle state to herdr's local socket API (`herdr pane report-agent` /
`herdr pane release-agent`). The plugin API only exposes `on`, so the hooks call
the `herdr` CLI via Node's own `child_process` (the injected `exec` is denied).

## State mapping

| GJC hook event            | herdr call                                | Result                         |
| ------------------------- | ----------------------------------------- | ------------------------------ |
| `session_start`           | `report-agent --state idle`               | Pane recognized as GJC on launch |
| `agent_start`             | `report-agent --state working`            | working                        |
| `tool_call` (target `ask`)| `report-agent --state blocked`            | blocked / `waiting`            |
| `tool_result` (target `ask`)| `report-agent --state working`          | back to working after answer   |
| `agent_end`               | `report-agent --state idle`               | idle                           |
| `session_shutdown`        | `release-agent` (synchronous)             | GJC removed from herdr on exit |

Notes:

- Every report carries a monotonic `--seq` (`Date.now()`). herdr ignores any
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

Restart GJC (or `gjc --resume`) after installing so the plugin loads. Plugins
load at session start; an already-running session is not affected until restart.

## Update after editing

Edit the source in this repo, then reinstall:

```bash
./reinstall.sh
# or: gjc plugin install --local ~/repos/herdr-gjc-plugin --user --force
```

`install` copies the validated, hashed files into
`~/.gjc/agent/gjc-plugins/herdr-agent-state/`, so this repo is the source of
truth and the installed copy runs independently.

## Uninstall

```bash
./uninstall.sh
```

Do **not** rely on `gjc plugin uninstall herdr-agent-state` — see Caveats.

## Scripts

| Script          | What it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| `install.sh`    | `gjc plugin install --local "$PWD" --user` (first install)          |
| `reinstall.sh`  | same with `--force` (apply edits)                                   |
| `uninstall.sh`  | removes the bundle directly (registry entry + installed dir)        |

## Caveats

1. **Restart to (un)load.** GJC loads plugins at session start. Install,
   reinstall, and uninstall only affect sessions started afterwards; a running
   session keeps whatever it loaded until you restart it (or `gjc --resume`).

2. **Never edit the installed copy.** The installed tree at
   `~/.gjc/agent/gjc-plugins/herdr-agent-state/` is hashed at install time.
   Editing it directly triggers a hash-drift quarantine and the hooks stop
   loading. Always edit here in the repo and run `./reinstall.sh`.

3. **`gjc plugin uninstall` does not remove this plugin.** `gjc plugin install
   --local` uses GJC's plugin-bundle installer, but `gjc plugin uninstall` only
   handles marketplace/npm plugins — it prints `✔ Uninstalled` without touching
   the GJC-bundle registry (`~/.gjc/agent/gjc-plugins/registry.json`) or the
   installed files. Use `./uninstall.sh`, which deletes the registry entry and
   the installed directory itself. (Observed on GJC 0.7.10.)

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
install.sh  reinstall.sh  uninstall.sh
```
