#!/usr/bin/env bash
# Reinstall this GJC plugin from the repo into the user scope.
# Run after editing the manifest or any hook. Restart GJC to load changes.
set -euo pipefail
cd "$(dirname "$0")"
gjc plugin install --local "$PWD" --user --force
echo "Reinstalled. Restart GJC (or 'gjc --resume') to load the changes."
