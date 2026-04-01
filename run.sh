#!/bin/bash
# PinchPTT launcher
# Source your .env or credentials file before running, or set env vars directly.
#
# Example:
#   cp .env.example .env   # edit with your values
#   ./run.sh
#
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Load .env if present
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

exec node "$SCRIPT_DIR/bridge.js"
