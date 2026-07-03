#!/usr/bin/env bash
# Uninstall this GJC plugin (user scope).
#
# `gjc plugin uninstall` does NOT work for locally-installed GJC plugin bundles:
# `gjc plugin install --local` uses the GJC-bundle installer, but the uninstall
# command only handles marketplace/npm plugins, so it prints "Uninstalled"
# without touching the GJC-bundle registry or files. This script removes the
# bundle directly: drop the registry entry and delete the installed directory.
set -euo pipefail

NAME="herdr-agent-state"
ROOT="${HOME}/.gjc/agent/gjc-plugins"
REG="${ROOT}/registry.json"

if [ -f "$REG" ]; then
	python3 - "$REG" "$NAME" <<'PY'
import json, sys
reg, name = sys.argv[1], sys.argv[2]
d = json.load(open(reg))
plugins = d.get("plugins", [])
kept = [p for p in plugins if p.get("name") != name]
d["plugins"] = kept
json.dump(d, open(reg, "w"), indent=2)
print(f"registry: removed {len(plugins) - len(kept)} entry(ies) for {name}")
PY
else
	echo "no user registry at $REG"
fi

if [ -d "${ROOT}/${NAME}" ]; then
	rm -rf "${ROOT:?}/${NAME}"
	echo "removed ${ROOT}/${NAME}"
fi

echo "Uninstalled ${NAME}. Restart GJC to unload it from any running session."
