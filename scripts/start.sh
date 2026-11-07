#!/bin/bash
# Start the proxy in the background (nohup mode). For a persistent LaunchAgent
# use scripts/install-launchd.sh instead.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_cmd node
mkdir -p "$LOG_DIR"

if proxy_healthy; then
  printf 'proxy already healthy at %s\n' "$HEALTH_URL"
  exit 0
fi

old_pid="$(proxy_pid)"
if pid_is_proxy "$old_pid"; then
  printf 'stopping stale proxy pid %s\n' "$old_pid"
  kill "$old_pid" 2>/dev/null || true
  sleep 1
fi

cd "$ROOT"
if [ ! -f dist/src/index.js ]; then
  require_cmd pnpm
  pnpm build
fi

# By default omit SONIOX_API_KEY so the proxy proves it can read the Keychain.
# Set KEEP_ENV_KEY=1 if you intentionally use an environment-provided key.
if [ "${KEEP_ENV_KEY:-0}" = "1" ]; then
  nohup env WS_MODE="${WS_MODE:-soniox}" DRY_RUN="${DRY_RUN:-false}" LOG_LEVEL="${LOG_LEVEL:-info}" \
    node dist/src/index.js >>"$LOG_DIR/proxy.stdout.log" 2>&1 &
else
  nohup env -u SONIOX_API_KEY WS_MODE="${WS_MODE:-soniox}" DRY_RUN="${DRY_RUN:-false}" LOG_LEVEL="${LOG_LEVEL:-info}" \
    node dist/src/index.js >>"$LOG_DIR/proxy.stdout.log" 2>&1 &
fi
echo "$!" >"$PID_FILE"

if ! wait_for_health 60; then
  printf 'proxy did not become healthy; see %s\n' "$LOG_DIR/proxy.stdout.log" >&2
  tail -20 "$LOG_DIR/proxy.stdout.log" >&2 || true
  exit 1
fi

printf 'proxy started (pid %s) at %s\n' "$(cat "$PID_FILE")" "$HEALTH_URL"
proxy_health_json
printf '\n'
