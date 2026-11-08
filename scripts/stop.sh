#!/bin/bash
# Stop the nohup-started proxy and the LaunchAgent, if loaded.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_cmd lsof
require_cmd jq

stop_pid() {
  local pid="$1" health instance
  health="$(proxy_health_json 2>/dev/null)" || return 0
  health_is_proxy "$pid" "$health" || return 0
  if ! pid_owns_listener "$pid"; then
    printf 'pid %s is not the proxy listener; not stopping it\n' "$pid" >&2
    return 0
  fi
  instance="$(printf '%s' "$health" | jq -r '.instance_id // empty' 2>/dev/null || true)"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 25); do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    if [ -n "$instance" ] && pid_is_proxy "$pid" "$instance"; then
      kill -9 "$pid" 2>/dev/null || true
    else
      printf 'pid %s changed identity; not escalating\n' "$pid" >&2
    fi
  fi
  printf 'stopped proxy pid %s\n' "$pid"
}

if launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; then
  if ! plist_targets_this_install || ! launchctl_service_is_this_install; then
    printf 'refusing to stop LaunchAgent for a different installation: %s\n' "$LAUNCHD_PLIST" >&2
    exit 1
  fi
  if ! launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL"; then
    printf 'failed to stop LaunchAgent %s\n' "$LAUNCHD_LABEL" >&2
    exit 1
  fi
  printf 'stopped LaunchAgent %s\n' "$LAUNCHD_LABEL"
fi

pid="$(proxy_pid)"
if pid_is_proxy "$pid"; then
  stop_pid "$pid"
else
  printf 'no running proxy pid found\n'
fi

# A manual start may have no usable PID file. Find the process that owns the
# health port and stop it only when its command is this proxy.
listener_pids="$(lsof -nP -iTCP:"$PROXY_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
for listener_pid in $listener_pids; do
  if pid_is_proxy "$listener_pid"; then
    stop_pid "$listener_pid"
  fi
done

listener_pids="$(lsof -nP -iTCP:"$PROXY_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -n "$listener_pids" ]; then
  printf 'listener still present on port %s (pid(s): %s); refusing to report success\n' \
    "$PROXY_PORT" "$(printf '%s' "$listener_pids" | tr '\n' ' ')" >&2
  exit 1
fi

rm -f "$PID_FILE"

if proxy_healthy; then
  printf 'warning: something is still answering on %s\n' "$HEALTH_URL" >&2
  exit 1
fi
printf 'proxy stopped\n'
