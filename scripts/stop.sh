#!/bin/bash
# Stop the nohup-started proxy and the LaunchAgent, if loaded.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  printf 'stopped LaunchAgent %s\n' "$LAUNCHD_LABEL"
fi

pid="$(proxy_pid)"
if pid_is_proxy "$pid"; then
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 25); do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  printf 'stopped proxy pid %s\n' "$pid"
else
  printf 'no running proxy pid found\n'
fi
rm -f "$PID_FILE"

if proxy_healthy; then
  printf 'warning: something is still answering on %s\n' "$HEALTH_URL" >&2
  exit 1
fi
printf 'proxy stopped\n'
