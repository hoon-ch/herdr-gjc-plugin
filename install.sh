#!/usr/bin/env bash
# Install this GJC plugin into the user scope (first-time install).
# For updates after editing, use ./reinstall.sh instead.
set -euo pipefail
cd "$(dirname "$0")"
gjc plugin install --local "$PWD" --user
echo "Installed. Restart GJC (or 'gjc --resume') to load it."
