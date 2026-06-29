#!/bin/bash
# launchd wrapper for the weekly timetable sync. launchd runs with a minimal
# environment (no shell profile), so we establish PATH for node/npm explicitly
# and cd into the project before running. Output is appended to sync.log.
set -euo pipefail

PROJECT_DIR="/Users/kelokchan/Work/af-calendar"
cd "$PROJECT_DIR"

# Make node/npm findable regardless of installer (Homebrew, nvm, system).
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/*/bin:/usr/bin:/bin:$PATH"
# If you use nvm, uncomment to load the default version:
# export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

echo "===== sync $(date '+%Y-%m-%d %H:%M:%S %Z') ====="
npm run sync
echo "===== done $(date '+%Y-%m-%d %H:%M:%S %Z') ====="
