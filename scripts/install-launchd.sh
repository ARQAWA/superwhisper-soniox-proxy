#!/bin/bash
# Install/refresh a LaunchAgent that keeps the proxy running at login.
# The agent does not receive SONIOX_API_KEY; the proxy reads it from Keychain.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_cmd node
require_cmd sed
require_cmd launchctl
mkdir -p "$(dirname "$LAUNCHD_PLIST")" "$LOG_DIR"

template="$ROOT/launchd/$LAUNCHD_LABEL.plist.template"
if [ ! -f "$template" ]; then
  printf 'missing LaunchAgent template: %s\n' "$template" >&2
  exit 1
fi

if [ -f "$LAUNCHD_PLIST" ] && ! plist_targets_this_install; then
  printf 'refusing to overwrite a LaunchAgent for a different installation: %s\n' "$LAUNCHD_PLIST" >&2
  exit 1
fi
if launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1 && ! launchctl_service_is_this_install; then
  printf 'refusing to replace a loaded LaunchAgent for a different installation: %s\n' "$LAUNCHD_LABEL" >&2
  exit 1
fi

if ! (cd "$ROOT" && bash scripts/stop.sh); then
  printf 'could not stop the previous proxy cleanly\n' >&2
  exit 1
fi

node_path="$(command -v node)"
if [ -f "$LAUNCHD_PLIST" ]; then
  /usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $node_path" "$LAUNCHD_PLIST"
else
  sed \
    -e "s|__LABEL__|$LAUNCHD_LABEL|g" \
    -e "s|__NODE__|$node_path|g" \
    -e "s|__ROOT__|$ROOT|g" \
    "$template" >"$LAUNCHD_PLIST"
fi
chmod 644 "$LAUNCHD_PLIST"

launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1 || true
if ! bootstrap_agent; then
  printf 'could not bootstrap LaunchAgent: %s\n' "$LAUNCHD_PLIST" >&2
  exit 1
fi
launchctl enable "gui/$(id -u)/$LAUNCHD_LABEL"
launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"

if ! wait_for_health 60; then
  printf 'LaunchAgent did not become healthy; inspect:\n' >&2
  printf '  launchctl print gui/%s/%s\n' "$(id -u)" "$LAUNCHD_LABEL" >&2
  printf '  tail %s/proxy.stderr.log\n' "$LOG_DIR" >&2
  exit 1
fi
printf 'LaunchAgent installed and healthy: %s\n' "$LAUNCHD_PLIST"
proxy_health_json
printf '\n'
