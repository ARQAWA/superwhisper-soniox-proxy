#!/bin/bash
# Verify that the local proxy, system proxy, certificate, key, and app signature
# are in the expected state. Prints no secrets and no transcript text.
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

failures=0
ok() { printf '  ok   %s\n' "$*"; }
bad() { printf '  FAIL %s\n' "$*"; failures=$((failures + 1)); }
warn() { printf '  warn %s\n' "$*"; }

printf 'proxy\n'
if proxy_healthy; then
  health="$(proxy_health_json)"
  ok "health endpoint: $HEALTH_URL"
  if printf '%s' "$health" | jq -e '.ok == true' >/dev/null 2>&1; then
    ok "health payload ok"
  else
    bad "health payload is not ok: $health"
  fi
  if printf '%s' "$health" | jq -e '.ws_mode == "soniox"' >/dev/null 2>&1; then
    ok "realtime bridge mode = soniox"
  else
    warn "realtime bridge is not in soniox mode: $health"
  fi
else
  bad "proxy is not answering at $HEALTH_URL"
fi

pid="$(proxy_pid)"
if pid_is_proxy "$pid"; then
  ok "nohup pid $pid is the proxy"
elif launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; then
  ok "LaunchAgent $LAUNCHD_LABEL is loaded"
else
  warn "no pid file and no LaunchAgent (proxy may be started another way)"
fi

printf 'certificates\n'
if [ -f "$CA_CRT" ]; then
  ok "CA file exists: $CA_CRT"
  days="$(ca_days_left)"
  if [ "$days" = "unknown" ]; then
    warn "could not read CA expiry"
  elif [ "$days" -lt 0 ]; then
    bad "CA expired ${days#-} days ago; run scripts/gen-certs.sh and re-trust"
  elif [ "$days" -lt 7 ]; then
    warn "CA expires in $days days; renew before it breaks the proxy"
  else
    ok "CA expires in $days days"
  fi
else
  bad "missing CA file: $CA_CRT"
fi
if [ -f "$LEAF_CRT" ]; then
  ok "leaf certificate exists: $LEAF_CRT"
else
  bad "missing leaf certificate: $LEAF_CRT"
fi
if ca_in_login_keychain; then
  ok "CA is in the login keychain"
else
  warn "CA is not in the login keychain (user trust)"
fi
if trust_settings_has_ca; then
  ok "CA has an explicit trust setting"
elif ca_chain_verifies; then
  ok "CA chain verifies through the keychain (implicit root trust)"
else
  warn "CA trust could not be verified (TLS may fail for the app)"
fi
if ca_in_system_keychain; then
  warn "CA is also in the System keychain (teardown needs sudo to remove it)"
fi

printf 'key\n'
if keychain_key_present; then
  ok "Soniox key is in Keychain service $KEYCHAIN_SERVICE"
else
  bad "Soniox key is missing; run scripts/setup.sh"
fi

printf 'system proxy\n'
enabled="$(networksetup -getsecurewebproxy "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^Enabled:/{print $2}')"
server="$(networksetup -getsecurewebproxy "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^Server:/{print $2}')"
port="$(networksetup -getsecurewebproxy "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^Port:/{print $2}')"
if [ "$enabled" = "Yes" ] && [ "$server" = "$PROXY_HOST" ] && [ "$port" = "$PROXY_PORT" ]; then
  ok "$NETWORK_SERVICE secure web proxy -> $PROXY_HOST:$PROXY_PORT"
else
  bad "$NETWORK_SERVICE secure web proxy is not $PROXY_HOST:$PROXY_PORT (enabled=$enabled server=${server:-} port=${port:-})"
fi

printf 'app\n'
if [ -d /Applications/SuperWhisper.app ]; then
  if codesign --verify --deep --strict /Applications/SuperWhisper.app >/dev/null 2>&1; then
    ok "codesign --verify --deep --strict passes"
  else
    bad "SuperWhisper code signature verification failed"
  fi
  if [ "$(csrutil status 2>/dev/null | grep -c 'enabled')" -gt 0 ]; then
    ok "System Integrity Protection is enabled"
  else
    warn "System Integrity Protection is not enabled"
  fi
else
  warn "SuperWhisper.app not found in /Applications"
fi

if [ "$failures" -eq 0 ]; then
  printf '\nhealth: OK\n'
  exit 0
fi
printf '\nhealth: %s failure(s)\n' "$failures"
exit 1
