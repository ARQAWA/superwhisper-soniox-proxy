#!/bin/bash
# One-time/idempotent setup for SuperWhisper -> local Soniox proxy.
#
# What it does:
#   - installs dependencies and builds
#   - creates a local CA/leaf certificate (if missing)
#   - stores the Soniox API key in Keychain (prompts if absent; never echoes it)
#   - trusts the local CA for the current user
#   - starts the proxy (nohup by default, LaunchAgent with --launchd)
#   - points the Wi-Fi secure web proxy at 127.0.0.1:8443
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
  --skip-proxy      Do not change the macOS secure web proxy setting.
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
if [ ! -f "$CA_CRT" ] || [ ! -f "$LEAF_CRT" ] || [ ! -f "$CERT_DIR/leaf.key" ]; then
  (cd "$ROOT" && bash scripts/gen-certs.sh)
else
  printf '  using existing %s\n' "$CA_CRT"
  if ! openssl x509 -in "$LEAF_CRT" -noout -ext subjectAltName 2>/dev/null | grep -q "api.elevenlabs.io"; then
    printf '  leaf certificate lacks api.elevenlabs.io; renewing\n'
    (cd "$ROOT" && bash scripts/gen-certs.sh)
  fi
  days="$(ca_days_left)"
  if [ "$days" != "unknown" ] && [ "$days" -lt 7 ]; then
    printf '  CA expires in %s days; renewing certificates\n' "$days"
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
if ca_in_login_keychain || trust_settings_has_ca || ca_chain_verifies; then
  printf '  CA is already present and trusted\n'
else
  # User-domain trust does not require sudo. The app runs as this user.
  if security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CA_CRT" >/dev/null 2>&1; then
    printf '  CA imported into the login keychain with user trust\n'
  else
    printf '  warning: could not add user trust automatically\n' >&2
    printf '  run: security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db %s\n' "$CA_CRT" >&2
  fi
fi

printf 'build\n'
(cd "$ROOT" && pnpm build)

printf 'proxy\n'
(cd "$ROOT" && bash scripts/stop.sh >/dev/null 2>&1 || true)
if [ "$USE_LAUNCHD" = "1" ]; then
  (cd "$ROOT" && bash scripts/install-launchd.sh)
else
  (cd "$ROOT" && bash scripts/start.sh)
fi

if [ "$CONFIGURE_APP" = "1" ]; then
  printf 'SuperWhisper mode\n'
  if ! (cd "$ROOT" && bash scripts/configure-superwhisper-mode.sh); then
    printf 'warning: could not create/activate the SuperWhisper mode.\n' >&2
    printf 'Run manually: bash %s/scripts/configure-superwhisper-mode.sh\n' "$ROOT" >&2
  fi
else
  printf 'SuperWhisper mode: not changed (use --configure-app to create/activate it)\n'
fi

if [ "$SKIP_PROXY" = "0" ]; then
  printf 'macOS secure web proxy\n'
  previous_enabled="$(networksetup -getsecurewebproxy "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^Enabled:/{print $2}')"
  previous_server="$(networksetup -getsecurewebproxy "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^Server:/{print $2}')"
  previous_port="$(networksetup -getsecurewebproxy "$NETWORK_SERVICE" 2>/dev/null | awk -F': ' '/^Port:/{print $2}')"
  {
    printf 'SETUP_AT=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'NETWORK_SERVICE=%s\n' "$NETWORK_SERVICE"
    printf 'PREVIOUS_ENABLED=%s\n' "${previous_enabled:-No}"
    printf 'PREVIOUS_SERVER=%s\n' "${previous_server:-}"
    printf 'PREVIOUS_PORT=%s\n' "${previous_port:-0}"
    printf 'LAUNCHD=%s\n' "$USE_LAUNCHD"
  } >"$STATE_FILE"
  networksetup -setsecurewebproxy "$NETWORK_SERVICE" "$PROXY_HOST" "$PROXY_PORT"
  networksetup -setsecurewebproxystate "$NETWORK_SERVICE" on
  printf '  %s secure proxy -> %s:%s\n' "$NETWORK_SERVICE" "$PROXY_HOST" "$PROXY_PORT"
else
  printf 'macOS secure web proxy: skipped\n'
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
