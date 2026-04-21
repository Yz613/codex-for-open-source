#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
VENV_DIR="$BACKEND_DIR/.venv"
PORT="${PORT:-8000}"
HOST="${HOST:-127.0.0.1}"
LOG_FILE="$HOME/Library/Logs/vibecode-cli-backend.log"
LAUNCH_AGENT_LABEL="local.codex.oss.clone.cli-backend"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT_PATH="$LAUNCH_AGENT_DIR/$LAUNCH_AGENT_LABEL.plist"

mkdir -p "$LAUNCH_AGENT_DIR" "$(dirname "$LOG_FILE")"
OLLAMA_APP_BIN_SYSTEM="/Applications/Ollama.app/Contents/Resources/ollama"
OLLAMA_APP_BIN_USER="$HOME/Applications/Ollama.app/Contents/Resources/ollama"
OLLAMA_BIN_PATH=""
OLLAMA_MODEL_PREFERRED="${OLLAMA_MODEL:-qwen2.5:1.5b}"

if [ ! -x "$VENV_DIR/bin/uvicorn" ]; then
  echo "Missing backend virtualenv. Run:" >&2
  echo "cd $BACKEND_DIR && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 1
fi

if [ -x "$OLLAMA_APP_BIN_SYSTEM" ]; then
  OLLAMA_BIN_PATH="$OLLAMA_APP_BIN_SYSTEM"
elif [ -x "$OLLAMA_APP_BIN_USER" ]; then
  OLLAMA_BIN_PATH="$OLLAMA_APP_BIN_USER"
elif [ -x "/usr/local/bin/ollama" ]; then
  OLLAMA_BIN_PATH="/usr/local/bin/ollama"
elif [ -x "/opt/homebrew/bin/ollama" ]; then
  OLLAMA_BIN_PATH="/opt/homebrew/bin/ollama"
elif command -v ollama >/dev/null 2>&1; then
  OLLAMA_BIN_PATH="$(command -v ollama)"
fi

start_ollama_service() {
  open -a Ollama >/dev/null 2>&1 || true
  for _ in {1..120}; do
    if curl -fsS "http://127.0.0.1:11434/api/tags" >/tmp/vibecode_ollama_tags.json 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

pick_installed_ollama_model() {
  local preferred="$1"
  local list_file="/tmp/vibecode_ollama_models.txt"

  if ! "$OLLAMA_BIN_PATH" list >"$list_file" 2>/dev/null; then
    echo ""
    return
  fi

  if awk 'NR>1 {print $1}' "$list_file" | grep -Fxq "$preferred"; then
    echo "$preferred"
    return
  fi

  awk 'NR>1 && $1 != "" {print $1; exit}' "$list_file"
}

if [ -n "$OLLAMA_BIN_PATH" ]; then
  start_ollama_service || true

  OLLAMA_MODEL_SELECTED="$(pick_installed_ollama_model "$OLLAMA_MODEL_PREFERRED")"
  if [ -z "$OLLAMA_MODEL_SELECTED" ]; then
    "$OLLAMA_BIN_PATH" pull "$OLLAMA_MODEL_PREFERRED" >/tmp/vibecode_ollama_pull.log 2>&1 || true
    OLLAMA_MODEL_SELECTED="$(pick_installed_ollama_model "$OLLAMA_MODEL_PREFERRED")"
  fi
  if [ -z "$OLLAMA_MODEL_SELECTED" ]; then
    OLLAMA_MODEL_SELECTED="$OLLAMA_MODEL_PREFERRED"
  fi

  MODEL_CLI_CMD_DEFAULT="$OLLAMA_BIN_PATH run $OLLAMA_MODEL_SELECTED --hidethinking --nowordwrap"
elif command -v qwen-cli >/dev/null 2>&1; then
  MODEL_CLI_CMD_DEFAULT="qwen-cli --model qwen2.5-7b --prompt"
elif command -v llama-cli >/dev/null 2>&1; then
  MODEL_CLI_CMD_DEFAULT="llama-cli -p"
else
  MODEL_CLI_CMD_DEFAULT="$VENV_DIR/bin/python $BACKEND_DIR/no_runner.py"
fi

MODEL_CLI_CMD_VALUE="${MODEL_CLI_CMD:-$MODEL_CLI_CMD_DEFAULT}"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "$value"
}

ESC_MODEL_CMD="$(xml_escape "$MODEL_CLI_CMD_VALUE")"
ESC_BACKEND_DIR="$(xml_escape "$BACKEND_DIR")"
ESC_UVICORN_PATH="$(xml_escape "$VENV_DIR/bin/uvicorn")"
ESC_HOST="$(xml_escape "$HOST")"
ESC_PORT="$(xml_escape "$PORT")"
ESC_LOG="$(xml_escape "$LOG_FILE")"

cat > "$LAUNCH_AGENT_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCH_AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd '$ESC_BACKEND_DIR' &amp;&amp; '$ESC_UVICORN_PATH' main:app --host '$ESC_HOST' --port '$ESC_PORT'</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MODEL_CLI_CMD</key>
    <string>$ESC_MODEL_CMD</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$ESC_BACKEND_DIR</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$ESC_LOG</string>
  <key>StandardErrorPath</key>
  <string>$ESC_LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$UID/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$LAUNCH_AGENT_PATH" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$UID/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1 || true

for _ in {1..120}; do
  if curl -fsS "http://$HOST:$PORT/health" >/tmp/vibecode_cli_health.json 2>/dev/null; then
    break
  fi
  sleep 0.2
done

echo "Started CLI backend service: $LAUNCH_AGENT_LABEL"
echo "MODEL_CLI_CMD=$MODEL_CLI_CMD_VALUE"
echo "Health: $(cat /tmp/vibecode_cli_health.json 2>/dev/null || echo 'unavailable')"
echo "Log: $LOG_FILE"
