#!/bin/bash
# One-time/idempotent setup for SuperWhisper -> local Soniox proxy.
#
# What it does:
#   - installs dependencies and builds
#   - creates a local CA/leaf certificate (if missing)
#   - stores the Soniox API key in Keychain (prompts if absent; never echoes it)
#   - trusts the local CA for the current user
#   - starts the proxy (nohup by default, LaunchAgent with --launchd)
#   - points the Wi-Fi PAC proxy at 127.0.0.1:8443 for allowlisted hosts only
#   - optionally creates/activates the SuperWhisper mode and runs smoke tests
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

CONFIGURE_APP=0
USE_LAUNCHD=0
RUN_SMOKE=0
SKIP_PROXY=0
INSTALL_DEPS=1

usage() {
  cat <<'EOF'
Usage: scripts/setup.sh [options]

Options:
  --configure-app   Create/refresh the SuperWhisper "Soniox Target" mode and make it active.
  --launchd         Install a LaunchAgent instead of using nohup.
  --smoke           Run target, pass-through, and realtime smoke tests at the end.
  --skip-proxy      Do not change the macOS proxy setting.
  --no-install      Do not run pnpm install if node_modules is missing.
  -h, --help        Show this help.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --configure-app) CONFIGURE_APP=1 ;;
    --launchd) USE_LAUNCHD=1 ;;
    --smoke) RUN_SMOKE=1 ;;
    --skip-proxy) SKIP_PROXY=1 ;;
    --no-install) INSTALL_DEPS=0 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

require_cmd node
require_cmd pnpm
require_cmd openssl
require_cmd curl
require_cmd jq
require_cmd security

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 22 ]; then
  printf 'Node >= 22 is required (found %s)\n' "$(node -v)" >&2
  exit 1
fi

if [ ! -f "$ROOT/node_modules/.modules.yaml" ]; then
  if [ "$INSTALL_DEPS" = "1" ]; then
    printf 'installing dependencies...\n'
    (cd "$ROOT" && pnpm install --frozen-lockfile)
  else
    printf 'node_modules is missing and --no-install was given\n' >&2
    exit 1
  fi
fi

printf 'certificates\n'
mkdir -p "$CERT_DIR"
CA_RENEWAL_FLAG="$CERT_DIR/.ca-renewal-pending"
CA_OLD_HASH_FILE="$CERT_DIR/.ca-renewal-old-hash"
CA_OLD_HASH=""
CA_CLEANUP_PENDING=0
login_cert_present() {
  local listing
  if ! listing="$(security find-certificate -a -Z "$HOME/Library/Keychains/login.keychain-db" 2>/dev/null)"; then
    return 2
  fi
  if printf '%s' "$listing" | grep -qi "SHA-1 hash: $1"; then
    return 0
  fi
  return 1
}

cleanup_login_cert() {
  local hash="$1" state
  login_cert_present "$hash" && state=0 || state=$?
  case "$state" in
    0)
      if ! security_timeout delete-certificate -t -Z "$hash" "$HOME/Library/Keychains/login.keychain-db" \
        >/dev/null 2>&1; then
        CA_CLEANUP_PENDING=1
      fi
      ;;
    2)
      CA_CLEANUP_PENDING=1
      ;;
  esac
}
CA_RENEWED=0
CA_RENEW_NOW=0
CA_LEAF_RENEW=0
CA_KEY="$CERT_DIR/ca.key"
if [ -f "$CA_RENEWAL_FLAG" ]; then
  CA_RENEWED=1
  CA_LEAF_RENEW=1
fi
if [ -f "$CA_CRT" ]; then
  if ! openssl x509 -in "$CA_CRT" -noout >/dev/null 2>&1; then
    printf '  CA certificate is invalid; regenerating\n'
    CA_RENEWED=1
    CA_RENEW_NOW=1
    : >"$CA_RENEWAL_FLAG"
  elif [ ! -f "$CA_KEY" ]; then
    printf '  CA private key is missing; regenerating root\n'
    CA_RENEWED=1
    CA_RENEW_NOW=1
    : >"$CA_RENEWAL_FLAG"
  elif ! openssl rsa -in "$CA_KEY" -check -noout >/dev/null 2>&1; then
    printf '  CA private key is corrupt; regenerating root\n'
    CA_RENEWED=1
    CA_RENEW_NOW=1
    : >"$CA_RENEWAL_FLAG"
  elif ! openssl x509 -in "$CA_CRT" -noout -text 2>/dev/null \
    | sed -n '/Basic Constraints/,+2p' | grep -q 'CA:TRUE'; then
    printf '  CA certificate is not a valid signing root; regenerating\n'
    CA_RENEWED=1
    CA_RENEW_NOW=1
    : >"$CA_RENEWAL_FLAG"
  elif [ "$(openssl x509 -in "$CA_CRT" -noout -subject -nameopt RFC2253 2>/dev/null | sed 's/^subject= *//' || true)" != "$(openssl x509 -in "$CA_CRT" -noout -issuer -nameopt RFC2253 2>/dev/null | sed 's/^issuer= *//' || true)" ] \
    || ! openssl verify -check_ss_sig -CAfile "$CA_CRT" "$CA_CRT" >/dev/null 2>&1; then
    printf '  CA certificate is not self-signed or self-verifying; regenerating\n'
    CA_RENEWED=1
    CA_RENEW_NOW=1
    : >"$CA_RENEWAL_FLAG"
  else
    crt_pub="$(openssl x509 -in "$CA_CRT" -noout -pubkey 2>/dev/null || true)"
    key_pub="$(openssl pkey -in "$CA_KEY" -pubout 2>/dev/null || true)"
    if [ -z "$crt_pub" ] || [ "$crt_pub" != "$key_pub" ]; then
      printf '  CA certificate and key do not match; regenerating root\n'
      CA_RENEWED=1
      CA_RENEW_NOW=1
      : >"$CA_RENEWAL_FLAG"
    else
      days="$(ca_days_left)"
      if ! openssl x509 -in "$CA_CRT" -checkend 604800 -noout >/dev/null 2>&1; then
        printf '  CA expires in %s days; renewing CA and leaf\n' "$days"
        CA_RENEWED=1
        CA_RENEW_NOW=1
        : >"$CA_RENEWAL_FLAG"
      fi
    fi
  fi
else
  printf '  CA certificate is missing; generating a new root\n'
  CA_RENEWED=1
  : >"$CA_RENEWAL_FLAG"
fi
if [ "$CA_RENEW_NOW" = "1" ]; then
  if [ -z "$CA_OLD_HASH" ] && [ -f "$CA_CRT" ]; then
    CA_OLD_HASH="$(openssl x509 -in "$CA_CRT" -noout -fingerprint -sha1 2>/dev/null \
      | sed 's/^.*=//; s/://g' || true)"
  fi
  (cd "$ROOT" && RENEW_CA=1 bash scripts/gen-certs.sh)
elif [ "$CA_LEAF_RENEW" = "1" ]; then
  printf '  resuming leaf renewal against the current CA\n'
  (cd "$ROOT" && bash scripts/gen-certs.sh)
elif [ ! -f "$CA_CRT" ] || [ ! -f "$LEAF_CRT" ] || [ ! -f "$CERT_DIR/leaf.key" ]; then
  (cd "$ROOT" && bash scripts/gen-certs.sh)
else
  printf '  using existing %s\n' "$CA_CRT"
  leaf_pub="$(openssl x509 -in "$LEAF_CRT" -noout -pubkey 2>/dev/null || true)"
  leaf_key_pub="$(openssl pkey -in "$CERT_DIR/leaf.key" -pubout 2>/dev/null || true)"
  if [ -z "$leaf_key_pub" ]; then
    printf '  leaf private key is invalid; preserve it and resolve manually\n' >&2
    exit 1
  fi
  if [ -z "$leaf_pub" ] || [ "$leaf_pub" != "$leaf_key_pub" ] \
    || ! openssl x509 -in "$LEAF_CRT" -checkend 604800 -noout >/dev/null 2>&1 \
    || ! openssl verify -CAfile "$CA_CRT" "$LEAF_CRT" >/dev/null 2>&1 \
    || ! openssl x509 -in "$LEAF_CRT" -noout -text 2>/dev/null | grep -Fq "DNS:api.deepgram.com" \
    || ! openssl x509 -in "$LEAF_CRT" -noout -text 2>/dev/null | grep -Fq "DNS:api.superwhisper.com" \
    || ! openssl x509 -in "$LEAF_CRT" -noout -text 2>/dev/null | grep -Fq "DNS:api.elevenlabs.io"; then
    printf '  leaf certificate needs renewal\n'
    (cd "$ROOT" && bash scripts/gen-certs.sh)
  fi
fi

printf 'Soniox API key\n'
if [ -n "${SONIOX_API_KEY:-}" ]; then
  security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w "$SONIOX_API_KEY" >/dev/null
  printf '  updated Keychain item from SONIOX_API_KEY\n'
elif keychain_key_present; then
  printf '  Keychain item already present (service %s)\n' "$KEYCHAIN_SERVICE"
else
  if [ ! -t 0 ]; then
    printf '  SONIOX_API_KEY is not set and stdin is not a terminal\n' >&2
    exit 1
  fi
  read -rsp "  Enter Soniox API key (input hidden): " key
  printf '\n'
  if [ -z "$key" ]; then
    printf '  empty key; aborting\n' >&2
    exit 1
  fi
  security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w "$key" >/dev/null
  unset key
  printf '  stored in Keychain\n'
fi

printf 'certificate trust\n'
need_trust=0
if ca_root_trusted && ca_chain_verifies; then
  printf '  current CA and leaf are already trusted\n'
else
  need_trust=1
fi
if [ "$need_trust" = "1" ]; then
  # User-domain trust does not require sudo. The app runs as this user.
  if security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CA_CRT" >/dev/null 2>&1; then
    printf '  CA imported into the login keychain with user trust\n'
  else
    printf '  could not add user trust automatically\n' >&2
    printf '  run: security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db %s\n' "$CA_CRT" >&2
    exit 1
  fi
fi
if ! ca_root_trusted || ! ca_chain_verifies; then
  printf '  current CA is not effectively trusted or does not verify the leaf\n' >&2
  exit 1
fi
if [ "$CA_RENEWED" = "1" ]; then
  if [ -n "$CA_OLD_HASH" ]; then
    cleanup_login_cert "$CA_OLD_HASH"
  fi
  if [ -f "$CA_OLD_HASH_FILE" ]; then
    while IFS= read -r old_hash; do
      if [ -z "$old_hash" ] || [ "$old_hash" = "$CA_OLD_HASH" ]; then
        continue
      fi
      cleanup_login_cert "$old_hash"
    done <"$CA_OLD_HASH_FILE"
  fi
  if [ "$CA_CLEANUP_PENDING" = "1" ]; then
    printf '  replaced-root cleanup incomplete; keeping the renewal marker for the next setup\n' >&2
  else
    rm -f "$CA_RENEWAL_FLAG"
  fi
fi

printf 'build\n'
build_proxy

printf 'proxy\n'
if ! (cd "$ROOT" && bash scripts/stop.sh); then
  printf 'could not stop the previous proxy cleanly; refusing to overwrite its service\n' >&2
  exit 1
fi
if [ "$USE_LAUNCHD" = "1" ]; then
  (cd "$ROOT" && bash scripts/install-launchd.sh)
else
  (cd "$ROOT" && bash scripts/start.sh)
fi

if [ "$CONFIGURE_APP" = "1" ]; then
  printf 'SuperWhisper mode\n'
  if ! (cd "$ROOT" && PRESERVE_MODE=1 bash scripts/configure-superwhisper-mode.sh); then
    printf 'warning: could not create/activate the SuperWhisper mode.\n' >&2
    printf 'Run manually: bash %s/scripts/configure-superwhisper-mode.sh\n' "$ROOT" >&2
  fi
else
  printf 'SuperWhisper mode: not changed (use --configure-app to create/activate it)\n'
fi

if [ "$SKIP_PROXY" = "0" ]; then
  printf 'macOS proxy (allowlist via PAC)\n'
  previous_enabled="$(networksetup -getsecurewebproxy "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^Enabled:/{print $2}')"
  previous_server="$(networksetup -getsecurewebproxy "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^Server:/{print $2}')"
  previous_port="$(networksetup -getsecurewebproxy "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^Port:/{print $2}')"
  previous_auto_url="$(networksetup -getautoproxyurl "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^URL:/{print $2}')"
  previous_auto_enabled="$(networksetup -getautoproxyurl "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^Enabled:/{print $2}')"
  [ "$previous_auto_url" = "(null)" ] && previous_auto_url=""
  encode_state_value() {
    printf '%s' "$1" | base64 | tr -d '\n'
  }
  state_is_stale=0
  if [ -f "$STATE_FILE" ]; then
    state_raw() {
      sed -n "s/^$1=//p" "$STATE_FILE" | head -n 1
    }
    decode_state_value() {
      local value="$1"
      printf '%s' "$value"
    }
    state_read() {
      local encoded
      encoded="$(state_raw "${1}_B64")"
      if [ -n "$encoded" ]; then
        printf '%s' "$encoded" | base64 -D 2>/dev/null
        return
      fi
      decode_state_value "$(state_raw "$1")"
    }
    state_service="$(state_read NETWORK_SERVICE)"
    if [ -n "$state_service" ] && [ "$state_service" != "$NETWORK_SERVICE" ]; then
      printf 'refusing to change network service from %s to %s; run teardown first\n' \
        "$state_service" "$NETWORK_SERVICE" >&2
      exit 1
    fi
    state_enabled="$(state_read PREVIOUS_ENABLED)"
    state_server="$(state_read PREVIOUS_SERVER)"
    state_port="$(state_read PREVIOUS_PORT)"
    state_setup_at="$(state_read SETUP_AT)"
    state_launchd="$(state_read LAUNCHD)"
    state_auto_enabled="$(state_read PREVIOUS_AUTO_ENABLED)"
    state_auto_url="$(state_read PREVIOUS_AUTO_URL)"
    [ "$state_auto_url" = "(null)" ] && state_auto_url=""
    if [ -z "$(state_raw PREVIOUS_AUTO_ENABLED_B64)$(state_raw PREVIOUS_AUTO_ENABLED)" ]; then
      state_auto_enabled="${previous_auto_enabled:-No}"
      state_auto_url="${previous_auto_url:-}"
    fi
    if [ "$state_enabled" = "Yes" ] && [ "$state_server" = "$PROXY_HOST" ] && [ "$state_port" = "$PROXY_PORT" ]; then
      # An older setup rerun recorded our own proxy as the previous proxy.
      # Preserve the original state if it is sane; otherwise record "disabled"
      # so teardown does not restore the proxy it is removing.
      state_is_stale=1
      printf '  correcting stale proxy state: %s\n' "$STATE_FILE"
    else
      # Re-running setup or upgrading must not replace the original
      # pre-install proxy with our own proxy. Rewrite as base64 data so a
      # service name containing spaces or quotes round-trips exactly.
      {
        printf 'SETUP_AT_B64=%s\n' "$(encode_state_value "$state_setup_at")"
        printf 'NETWORK_SERVICE_B64=%s\n' "$(encode_state_value "$state_service")"
        printf 'PREVIOUS_ENABLED_B64=%s\n' "$(encode_state_value "$state_enabled")"
        printf 'PREVIOUS_SERVER_B64=%s\n' "$(encode_state_value "$state_server")"
        printf 'PREVIOUS_PORT_B64=%s\n' "$(encode_state_value "$state_port")"
        printf 'LAUNCHD_B64=%s\n' "$(encode_state_value "$state_launchd")"
        printf 'PREVIOUS_AUTO_ENABLED_B64=%s\n' "$(encode_state_value "${state_auto_enabled:-No}")"
        printf 'PREVIOUS_AUTO_URL_B64=%s\n' "$(encode_state_value "${state_auto_url:-}")"
      } >"$STATE_FILE.migrate.$$"
      mv "$STATE_FILE.migrate.$$" "$STATE_FILE"
      printf '  preserving original proxy state: %s\n' "$STATE_FILE"
    fi
  fi
  if [ ! -f "$STATE_FILE" ] || [ "$state_is_stale" = "1" ]; then
    if [ "$previous_enabled" = "Yes" ] && [ "$previous_server" = "$PROXY_HOST" ] && [ "$previous_port" = "$PROXY_PORT" ]; then
      # An older install may have set the proxy without recording its origin.
      previous_enabled=No
      previous_server=""
      previous_port=0
    fi
    {
      printf 'SETUP_AT_B64=%s\n' "$(encode_state_value "$(date -u '+%Y-%m-%dT%H:%M:%SZ')")"
      printf 'NETWORK_SERVICE_B64=%s\n' "$(encode_state_value "$NETWORK_SERVICE")"
      printf 'PREVIOUS_ENABLED_B64=%s\n' "$(encode_state_value "${previous_enabled:-No}")"
      printf 'PREVIOUS_SERVER_B64=%s\n' "$(encode_state_value "${previous_server:-}")"
      printf 'PREVIOUS_PORT_B64=%s\n' "$(encode_state_value "${previous_port:-0}")"
      printf 'LAUNCHD_B64=%s\n' "$(encode_state_value "$USE_LAUNCHD")"
      printf 'PREVIOUS_AUTO_ENABLED_B64=%s\n' "$(encode_state_value "${previous_auto_enabled:-No}")"
      printf 'PREVIOUS_AUTO_URL_B64=%s\n' "$(encode_state_value "${previous_auto_url:-}")"
    } >"$STATE_FILE"
  fi
  mkdir -p "$(dirname "$PAC_PATH")"
  node "$ROOT/dist/src/pac-cli.js" \
    --host "$PROXY_HOST" --port "$PROXY_PORT" \
    --hosts "$PROXY_ALLOWED_HOSTS" --out "$PAC_PATH" >/dev/null
  # Only the allowlisted hosts go through the proxy; the PAC returns DIRECT
  # for everything else, so unrelated apps never touch the proxy.
  networksetup -setsecurewebproxystate "$NETWORK_SERVICE" off
  networksetup -setautoproxyurl "$NETWORK_SERVICE" "http://${PROXY_HOST}:${PROXY_PORT}/proxy.pac"
  networksetup -setautoproxystate "$NETWORK_SERVICE" on
  printf '  %s PAC proxy -> %s:%s\n' "$NETWORK_SERVICE" "$PROXY_HOST" "$PROXY_PORT"
  printf '  allowlist: %s\n' "$PROXY_ALLOWED_HOSTS"
else
  printf 'macOS proxy: skipped\n'
fi

printf 'health\n'
(cd "$ROOT" && bash scripts/health.sh)

if [ "$RUN_SMOKE" = "1" ]; then
  printf 'smoke tests\n'
  (cd "$ROOT" && bash scripts/smoke-target.sh)
  (cd "$ROOT" && bash scripts/smoke-passthrough.sh)
  (cd "$ROOT" && node scripts/smoke-realtime.mjs)
fi

printf '\nsetup complete\n'
printf 'Active SuperWhisper mode: %s\n' "$(defaults read com.superduper.superwhisper activeModeKey 2>/dev/null || echo 'unknown')"
printf 'Teardown: bash scripts/teardown.sh\n'
