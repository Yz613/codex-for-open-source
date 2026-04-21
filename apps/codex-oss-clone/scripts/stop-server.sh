#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-4310}"
LAUNCH_AGENT_LABEL="local.codex.oss.clone.server"

launchctl bootout "gui/$UID/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1 || true

if lsof -ti tcp:"$PORT" >/tmp/codex_oss_clone_port_pids 2>/dev/null && [ -s /tmp/codex_oss_clone_port_pids ]; then
  while read -r pid; do
    kill "$pid" >/dev/null 2>&1 || true
  done < /tmp/codex_oss_clone_port_pids
fi

echo "Stopped Codex OSS Clone server on port $PORT"
