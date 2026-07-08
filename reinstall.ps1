# Reinstall this GJC plugin from the repo into the user scope.
# Run after editing the manifest or any hook. Restart GJC to load changes.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
gjc plugin install --local $PSScriptRoot --user --force
Write-Host "Reinstalled. Restart GJC (or 'gjc --resume') to load the changes."
