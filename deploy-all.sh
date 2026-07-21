#!/usr/bin/env bash
# Deploy this plugin to the local machine and every SSH target listed in a local
# .deploy-targets file. The targets file is gitignored so private hostnames stay
# out of the public repo.
set -euo pipefail
cd "$(dirname "$0")"

CONFIG="${HERDR_GJC_DEPLOY_TARGETS:-.deploy-targets}"
PLUGIN_NAME="herdr-agent-state"
VERSION="$(node -e 'console.log(require("./gajae-plugin.json").version)')"

HAS_TARGETS=1
if [[ ! -f "$CONFIG" ]]; then
	if [[ -n "${HERDR_GJC_DEPLOY_TARGETS:-}" ]]; then
		echo "Deploy target file not found: $CONFIG" >&2
		exit 2
	fi
	HAS_TARGETS=0
fi

copy_to_unix() {
	local host="$1"
	echo "==> $host (unix): syncing"
	ssh -n "$host" 'mkdir -p ~/repos/herdr-gjc-plugin'
	rsync -a --delete \
		--exclude .git \
		--exclude .gjc \
		--exclude .deploy-targets \
		--exclude '.deploy-targets.*' \
		./ "$host:~/repos/herdr-gjc-plugin/"
	echo "==> $host (unix): reinstalling"
	ssh -n "$host" 'cd ~/repos/herdr-gjc-plugin && ./reinstall.sh'
	echo "==> $host (unix): verifying"
	ssh -n "$host" "node -e 'const fs=require(\"node:fs\"); const r=JSON.parse(fs.readFileSync(process.env.HOME+\"/.gjc/agent/gjc-plugins/registry.json\",\"utf8\")); const p=r.plugins.find(p=>p.name===\"$PLUGIN_NAME\"); if(!p || p.version!==\"$VERSION\" || !p.enabled){throw new Error(JSON.stringify(p));} console.log(\"verified $PLUGIN_NAME \"+p.version);'"
}

copy_to_windows() {
	local host="$1"
	echo "==> $host (windows): syncing"
	ssh -n "$host" 'New-Item -ItemType Directory -Force "$HOME\repos\herdr-gjc-plugin\hooks" | Out-Null'
	scp gajae-plugin.json README.md install.ps1 reinstall.ps1 uninstall.ps1 install.sh reinstall.sh uninstall.sh deploy-all.sh "$host:repos/herdr-gjc-plugin/"
	scp hooks/startup.ts hooks/working.ts hooks/turn.ts hooks/idle.ts hooks/blocked.ts hooks/unblock.ts hooks/shutdown.ts "$host:repos/herdr-gjc-plugin/hooks/"
	echo "==> $host (windows): reinstalling"
	ssh -n "$host" 'Set-Location "$HOME\repos\herdr-gjc-plugin"; .\reinstall.ps1'
	echo "==> $host (windows): verifying"
	ssh -n "$host" "\$r = Get-Content \"\$HOME\\.gjc\\agent\\gjc-plugins\\registry.json\" -Raw | ConvertFrom-Json; \$p = \$r.plugins | Where-Object { \$_.name -eq '$PLUGIN_NAME' }; if (-not \$p -or \$p.version -ne '$VERSION' -or -not \$p.enabled) { throw (\$p | ConvertTo-Json -Compress) }; Write-Host ('verified $PLUGIN_NAME ' + \$p.version)"
}

echo "==> local: reinstalling $PLUGIN_NAME $VERSION"
./reinstall.sh

if [[ "$HAS_TARGETS" -eq 0 ]]; then
	echo "No .deploy-targets file found; local reinstall only."
	echo "Create .deploy-targets to sync private remote hosts."
	exit 0
fi

while IFS= read -r line || [[ -n "$line" ]]; do
	line="${line%%#*}"
	[[ -z "${line//[[:space:]]/}" ]] && continue
	read -r kind host marker extra <<<"$line"
	if [[ -z "${kind:-}" || -n "${extra:-}" || ( -n "${marker:-}" && "$marker" != "self" ) ]]; then
		echo "Invalid target line: $line" >&2
		exit 2
	fi
	if [[ "$kind" == "self" || "$kind" == "local" || "${marker:-}" == "self" ]]; then
		echo "==> ${host:-local}: skipping remote sync for this machine"
		continue
	fi
	case "$kind" in
		unix) copy_to_unix "$host" ;;
		windows) copy_to_windows "$host" ;;
		*)
			echo "Unknown target kind '$kind' for host '$host'" >&2
			exit 2
			;;
	esac
done <"$CONFIG"

echo "Deployed $PLUGIN_NAME $VERSION. Restart or resume GJC sessions to load it."
