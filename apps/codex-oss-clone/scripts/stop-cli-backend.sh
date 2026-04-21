#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
LAUNCH_AGENT_LABEL="local.codex.oss.clone.cli-backend"
LAUNCH_AGENT_PATH="$HOME/Library/LaunchAgents/$LAUNCH_AGENT_LABEL.plist"

launchctl bootout "gui/$UID/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1 || true

if lsof -ti tcp:"$PORT" >/tmp/vibecode_cli_backend_pids 2>/dev/null && [ -s /tmp/vibecode_cli_backend_pids ]; then
  while read -r pid; do
    kill "$pid" >/dev/null 2>&1 || true
  done < /tmp/vibecode_cli_backend_pids
fi

rm -f "$LAUNCH_AGENT_PATH"

echo "Stopped CLI backend on port $PORT"
