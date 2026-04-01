#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
set -a
source /home/flog/.openclaw/credentials/credentials.env
set +a
exec node /home/flog/opt/openclaw-services/zello-voice-bridge/bridge.js
