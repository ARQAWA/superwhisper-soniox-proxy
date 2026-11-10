#!/bin/bash
# Verify that the local proxy, system proxy, certificate, key, and recognition
# context are in the expected state. Prints no secrets and no transcript text.
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

printf 'recognition context\n'
require_cmd jq
if [ -f "$SONIOX_CONTEXT_FILE" ] && jq -e 'type == "object"' "$SONIOX_CONTEXT_FILE" >/dev/null 2>&1; then
  context_summary="$(jq -r '"\((.terms // [] | length)) terms, \((.text // "" | length)) text chars"' "$SONIOX_CONTEXT_FILE")"
  ok "context prompt: $context_summary"
else
  warn "context prompt is missing or invalid: $SONIOX_CONTEXT_FILE (run scripts/configure-soniox-context.sh)"
fi

printf 'diagnostics\n'
diag_dir="${DIAG_DIR:-$HOME/Library/Caches/soniox-proxy/diagnostics}"
if [ -d "$diag_dir" ]; then
  ok "diagnostics dir: $diag_dir"
  traces="$(find "$diag_dir/sessions" -type f -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
  ok "session traces: ${traces:-0}"
  if [ -f "$diag_dir/summary.jsonl" ]; then
    last_status="$(tail -n 1 "$diag_dir/summary.jsonl" 2>/dev/null | jq -r '.status // "unknown"' 2>/dev/null)"
    ok "last session status: ${last_status:-unknown}"
  else
    warn "no session summaries yet"
  fi
  if [ -f "$diag_dir/anomalies.jsonl" ]; then
    anomalies="$(wc -l <"$diag_dir/anomalies.jsonl" 2>/dev/null | tr -d ' ')"
    if [ "${anomalies:-0}" -gt 0 ]; then
      warn "anomaly records: $anomalies (review: bash scripts/diagnostics.sh)"
    else
      ok "no anomaly records"
    fi
  fi
else
  warn "diagnostics dir missing: $diag_dir (start the new proxy build to enable)"
fi

printf 'system proxy\n'
auto_enabled="$(networksetup -getautoproxyurl "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^Enabled:/{print $2}')"
auto_url="$(networksetup -getautoproxyurl "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^URL:/{print $2}')"
expected_auto_url="http://${PROXY_HOST}:${PROXY_PORT}/proxy.pac"
if [ "$auto_enabled" = "Yes" ] && [ "$auto_url" = "$expected_auto_url" ]; then
  ok "$NETWORK_SERVICE PAC proxy -> $PROXY_HOST:$PROXY_PORT"
else
  bad "$NETWORK_SERVICE PAC proxy is not $expected_auto_url (enabled=$auto_enabled url=${auto_url:-})"
fi
if [ -f "$PAC_PATH" ]; then
  pac_ok=1
  IFS=',' read -r -a pac_hosts <<<"$PROXY_ALLOWED_HOSTS"
  for pac_host in "${pac_hosts[@]}"; do
    pac_host="$(printf '%s' "$pac_host" | tr -d '[:space:]')"
    [ -z "$pac_host" ] && continue
    if ! grep -Fq "\"$pac_host\"" "$PAC_PATH"; then
      pac_ok=0
    fi
  done
  if [ "$pac_ok" = "1" ]; then
    ok "PAC allowlist: $PROXY_ALLOWED_HOSTS"
  else
    bad "PAC does not contain every allowlisted host: $PROXY_ALLOWED_HOSTS"
  fi
else
  bad "missing PAC file: $PAC_PATH"
fi
secure_enabled="$(networksetup -getsecurewebproxy "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^Enabled:/{print $2}')"
if [ "$secure_enabled" = "Yes" ]; then
  warn "$NETWORK_SERVICE secure web proxy is still enabled; it would capture every host"
fi

if [ "$failures" -eq 0 ]; then
  printf '\nhealth: OK\n'
  exit 0
fi
printf '\nhealth: %s failure(s)\n' "$failures"
exit 1
