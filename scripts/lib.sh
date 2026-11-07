#!/bin/bash
# Shared helpers for the local SuperWhisper <-> Soniox proxy scripts.
# This file is sourced by the other scripts; it intentionally contains no secrets.

if [ -z "${ROOT:-}" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

PROXY_HOST="${PROXY_HOST:-127.0.0.1}"
PROXY_PORT="${PROXY_PORT:-8443}"
HEALTH_URL="http://${PROXY_HOST}:${PROXY_PORT}/__health"
NETWORK_SERVICE="${NETWORK_SERVICE:-Wi-Fi}"
CA_CN="SuperWhisper Soniox Local CA"
CERT_DIR="${CERT_DIR:-$ROOT/certs}"
CA_CRT="${CA_CRT:-$CERT_DIR/ca.crt}"
LEAF_CRT="${LEAF_CRT:-$CERT_DIR/leaf.crt}"
LOG_DIR="${LOG_DIR:-$ROOT/logs}"
PID_FILE="${PID_FILE:-$LOG_DIR/proxy.pid}"
STATE_FILE="${STATE_FILE:-$LOG_DIR/setup-state.env}"
LAUNCHD_LABEL="${LAUNCHD_LABEL:-com.superwhisper.soniox-proxy}"
LAUNCHD_PLIST="${LAUNCHD_PLIST:-$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist}"
KEYCHAIN_SERVICE="${KEYCHAIN_SERVICE:-soniox-proxy}"
KEYCHAIN_ACCOUNT="${KEYCHAIN_ACCOUNT:-SONIOX_API_KEY}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

proxy_health_json() {
  curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null
}

proxy_healthy() {
  proxy_health_json >/dev/null 2>&1
}

wait_for_health() {
  local attempts="${1:-50}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if proxy_healthy; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

proxy_pid() {
  if [ -f "$PID_FILE" ]; then
    cat "$PID_FILE" 2>/dev/null || true
  fi
}

pid_is_proxy() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep -q 'dist/src/index.js'
}

keychain_key_present() {
  security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1
}

ca_in_login_keychain() {
  security find-certificate -c "$CA_CN" "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1
}

ca_in_system_keychain() {
  security find-certificate -c "$CA_CN" /Library/Keychains/System.keychain >/dev/null 2>&1
}

ca_trust_setting_count() {
  {
    security dump-trust-settings 2>/dev/null
    security dump-trust-settings -d 2>/dev/null
  } | awk -v cn="$CA_CN" '
    $0 ~ "^Cert [0-9]+: " cn { found = 1; next }
    found && /Number of trust settings/ {
      gsub(/[^0-9]/, "", $0)
      print $0 + 0
      exit
    }
  '
}

trust_settings_has_ca() {
  local count
  count="$(ca_trust_setting_count)"
  [ -n "$count" ] && [ "$count" -gt 0 ]
}

ca_chain_verifies() {
  [ -f "$LEAF_CRT" ] && security verify-cert -c "$LEAF_CRT" -p ssl >/dev/null 2>&1
}

ca_days_left() {
  local end
  end="$(openssl x509 -in "$CA_CRT" -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [ -z "$end" ]; then
    printf 'unknown\n'
    return
  fi
  local end_epoch now_epoch
  end_epoch="$(date -j -f '%b %d %H:%M:%S %Y %Z' "$end" '+%s' 2>/dev/null || true)"
  now_epoch="$(date '+%s')"
  if [ -z "$end_epoch" ]; then
    printf 'unknown\n'
    return
  fi
  printf '%s\n' "$(((end_epoch - now_epoch) / 86400))"
}
