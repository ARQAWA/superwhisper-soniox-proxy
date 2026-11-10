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
PAC_PATH="${PAC_PATH:-$LOG_DIR/proxy.pac}"
PROXY_ALLOWED_HOSTS="${PROXY_ALLOWED_HOSTS:-api.superwhisper.com,api.deepgram.com,api.elevenlabs.io,api.soniox.com}"
SONIOX_CONTEXT_FILE="${SONIOX_CONTEXT_FILE:-$HOME/.config/soniox-proxy/context.json}"
SONIOX_CONTEXT_PROFILE="${SONIOX_CONTEXT_PROFILE:-$ROOT/profiles/soniox-context.json}"
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

build_proxy() (
  local build_dir="" build_backup="" build_swapped=0
  cleanup_build() {
    if [ "$build_swapped" = "0" ] && [ -n "$build_backup" ] && [ -e "$build_backup/dist" ]; then
      if [ -e "$ROOT/dist" ] || ! mv "$build_backup/dist" "$ROOT/dist"; then
        printf 'previous build remains at %s/dist\n' "$build_backup" >&2
        return
      fi
    fi
    [ -z "$build_dir" ] || rm -rf "$build_dir"
    [ -z "$build_backup" ] || rm -rf "$build_backup"
  }
  trap cleanup_build EXIT
  cd "$ROOT" || return 1
  build_dir="$(mktemp -d "$ROOT/.dist-build.XXXXXX")" || return 1
  build_backup="$(mktemp -d "$ROOT/.dist-backup.XXXXXX")" || return 1
  pnpm exec tsc -p tsconfig.json --outDir "$build_dir" || return 1
  if [ -e "$ROOT/dist" ]; then
    mv "$ROOT/dist" "$build_backup/dist" || return 1
  fi
  mv "$build_dir" "$ROOT/dist" || return 1
  build_swapped=1
)

security_timeout() {
  local timeout_bin=""
  if command -v timeout >/dev/null 2>&1; then
    timeout_bin="$(command -v timeout)"
  elif [ -x /opt/homebrew/bin/timeout ]; then
    timeout_bin="/opt/homebrew/bin/timeout"
  elif [ -x /usr/bin/timeout ]; then
    timeout_bin="/usr/bin/timeout"
  fi
  if [ -n "$timeout_bin" ]; then
    "$timeout_bin" 8 security "$@"
  elif command -v perl >/dev/null 2>&1; then
    perl -e 'alarm 8; exec @ARGV' security "$@"
  else
    printf 'skipping interactive security command (no timeout tool): security %s\n' "$*" >&2
    return 1
  fi
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

health_is_proxy() {
  local pid="$1" health="$2" expected_instance="${3:-}"
  # Accept a new proxy only when both identity fields are present. A legacy
  # proxy has neither; a partial payload is not accepted.
  if printf '%s' "$health" | jq -e 'has("pid") or has("entry_path")' >/dev/null 2>&1; then
    printf '%s' "$health" | jq -e --arg pid "$pid" --arg entry "$ROOT/dist/src/index.js" --arg instance "$expected_instance" '
      .pid == ($pid | tonumber)
      and .entry_path == $entry
      and (($instance == "") or (.instance_id == $instance))
    ' >/dev/null 2>&1
    return
  fi

  # Pre-change proxies have neither identity field. Accept only a process
  # owning the IPv4 health listener from this installation with the exact
  # target fields. Never use this path for escalation.
  [ -z "$expected_instance" ] || return 1
  pid_owns_listener "$pid" || return 1
  pid_cwd_is_root "$pid" || return 1
  printf '%s' "$health" | jq -e '
    .ok == true
    and .target_host == "api.deepgram.com"
    and .target_path == "/v1/listen"
    and .ws_mode == "soniox"
    and .soniox_realtime_model == "stt-rt-v6"
  ' >/dev/null 2>&1
}

pid_is_proxy() {
  local pid="${1:-}" expected_instance="${2:-}" health
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  health="$(proxy_health_json)" || return 1
  health_is_proxy "$pid" "$health" "$expected_instance"
}

pid_owns_listener() {
  local pid="${1:-}"
  [ -n "$pid" ] && lsof -nP -iTCP@"$PROXY_HOST":"$PROXY_PORT" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$pid"
}

pid_cwd_is_root() {
  local pid="${1:-}" cwd
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  [ "$cwd" = "$ROOT" ]
}

plist_targets_this_install() {
  [ -f "$LAUNCHD_PLIST" ] || return 1
  # The template has no separate Program; launchd execs ProgramArguments[0].
  # Reject a Program override and validate the effective executable and entry.
  if /usr/libexec/PlistBuddy -c 'Print :Program' "$LAUNCHD_PLIST" >/dev/null 2>&1; then
    return 1
  fi
  local executable entry
  executable="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$LAUNCHD_PLIST" 2>/dev/null || true)"
  entry="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$LAUNCHD_PLIST" 2>/dev/null || true)"
  [ "$(basename "$executable")" = "node" ] || return 1
  [ "$entry" = "$ROOT/dist/src/index.js" ]
}

launchctl_service_is_this_install() {
  local program args executable entry
  program="$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*program = //p' | head -n 1)"
  args="$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | sed -n '/arguments = {/,/}/p')"
  args="$(printf '%s\n' "$args" | sed '1d;$d' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  executable="$(printf '%s\n' "$args" | sed -n '1p')"
  entry="$(printf '%s\n' "$args" | sed -n '2p')"
  [ "$(basename "$program")" = "node" ] || return 1
  [ "$(basename "$executable")" = "node" ] || return 1
  [ "$entry" = "$ROOT/dist/src/index.js" ]
}

bootstrap_agent() {
  local _
  for _ in $(seq 1 40); do
    if launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  return 1
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
  local expected anchor
  [ -f "$CA_CRT" ] && [ -f "$LEAF_CRT" ] || return 1
  expected="$(openssl x509 -in "$CA_CRT" -noout -fingerprint -sha256 2>/dev/null)" || return 1
  anchor="$(security verify-cert -c "$LEAF_CRT" -c "$CA_CRT" -p ssl -P 2>/dev/null \
    | awk '
      /-----BEGIN CERTIFICATE-----/ { cert = ""; capture = 1 }
      capture { cert = cert $0 ORS }
      /-----END CERTIFICATE-----/ { capture = 0 }
      END { printf "%s", cert }
    ' | openssl x509 -noout -fingerprint -sha256 2>/dev/null)" || return 1
  [ -n "$expected" ] && [ "$anchor" = "$expected" ]
}

ca_root_trusted() {
  [ -f "$CA_CRT" ] && security verify-cert -c "$CA_CRT" -p ssl >/dev/null 2>&1
}

ca_days_left() {
  local end
  end="$(openssl x509 -in "$CA_CRT" -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [ -z "$end" ]; then
    printf 'unknown\n'
    return
  fi
  local end_epoch now_epoch
  end_epoch="$(LC_ALL=C TZ=GMT date -j -f '%b %d %H:%M:%S %Y' "${end% GMT}" '+%s' 2>/dev/null || true)"
  now_epoch="$(date '+%s')"
  if [ -z "$end_epoch" ]; then
    printf 'unknown\n'
    return
  fi
  printf '%s\n' "$(((end_epoch - now_epoch) / 86400))"
}
