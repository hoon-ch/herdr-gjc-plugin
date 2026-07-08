# Install this GJC plugin into the user scope (first-time install).
# For updates after editing, use .\reinstall.ps1 instead.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
gjc plugin install --local $PSScriptRoot --user
Write-Host "Installed. Restart GJC (or 'gjc --resume') to load it."
