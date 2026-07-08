# Uninstall this GJC plugin (user scope).
#
# `gjc plugin uninstall` does NOT work for locally-installed GJC plugin bundles:
# `gjc plugin install --local` uses the GJC-bundle installer, but the uninstall
# command only handles marketplace/npm plugins, so it prints "Uninstalled"
# without touching the GJC-bundle registry or files. This script removes the
# bundle directly: drop the registry entry and delete the installed directory.
$ErrorActionPreference = "Stop"

$Name = "herdr-agent-state"
$Root = Join-Path $HOME ".gjc\agent\gjc-plugins"
$Reg = Join-Path $Root "registry.json"

if (Test-Path $Reg) {
	$data = Get-Content $Reg -Raw | ConvertFrom-Json
	$plugins = @($data.plugins)
	$kept = @($plugins | Where-Object { $_.name -ne $Name })
	if ($null -eq $data.PSObject.Properties["plugins"]) {
		$data | Add-Member -NotePropertyName "plugins" -NotePropertyValue $kept
	} else {
		$data.plugins = $kept
	}
	$data | ConvertTo-Json -Depth 20 | Set-Content -Path $Reg -Encoding UTF8
	Write-Host "registry: removed $($plugins.Count - $kept.Count) entry(ies) for $Name"
} else {
	Write-Host "no user registry at $Reg"
}

$Installed = Join-Path $Root $Name
if (Test-Path $Installed) {
	Remove-Item -LiteralPath $Installed -Recurse -Force
	Write-Host "removed $Installed"
}

Write-Host "Uninstalled $Name. Restart GJC to unload it from any running session."
