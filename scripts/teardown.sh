#!/bin/bash
# Reverse the system-level changes made by setup.sh. Keeps certificates and the
# Soniox key by default so a later setup can reuse them.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

REMOVE_KEY=0
REMOVE_CERTS=0

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

usage() {
  cat <<'EOF'
Usage: scripts/teardown.sh [options]

Options:
  --remove-key     Also delete the Soniox API key from Keychain.
  --remove-certs   Also delete the generated certs directory.
  -h, --help       Show this help.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --remove-key) REMOVE_KEY=1 ;;
    --remove-certs) REMOVE_CERTS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

printf 'stopping proxy\n'
(cd "$ROOT" && bash scripts/stop.sh || true)
launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1 || true
rm -f "$LAUNCHD_PLIST"

printf 'restoring macOS secure web proxy\n'
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  if [ "${PREVIOUS_ENABLED:-No}" = "Yes" ] && [ -n "${PREVIOUS_SERVER:-}" ] && [ "${PREVIOUS_PORT:-0}" != "0" ]; then
    networksetup -setsecurewebproxy "${NETWORK_SERVICE:-$NETWORK_SERVICE}" "$PREVIOUS_SERVER" "$PREVIOUS_PORT"
    networksetup -setsecurewebproxystate "${NETWORK_SERVICE:-$NETWORK_SERVICE}" on
    printf '  restored previous proxy %s:%s\n' "$PREVIOUS_SERVER" "$PREVIOUS_PORT"
  else
    networksetup -setsecurewebproxystate "${NETWORK_SERVICE:-$NETWORK_SERVICE}" off
    printf '  disabled secure web proxy\n'
  fi
  rm -f "$STATE_FILE"
else
  networksetup -setsecurewebproxystate "$NETWORK_SERVICE" off
  printf '  disabled secure web proxy\n'
fi

printf 'removing local CA trust\n'
if security_timeout remove-trusted-cert "$CA_CRT" >/dev/null 2>&1; then
  printf '  removed user-domain trust\n'
else
  printf '  user-domain trust not removed automatically (it may require Keychain authorization)\n'
fi
if security dump-trust-settings 2>/dev/null | grep -q "$CA_CN"; then
  if sudo -n true >/dev/null 2>&1; then
    sudo -n security remove-trusted-cert -d "$CA_CRT" >/dev/null 2>&1 || true
    printf '  removed admin-domain trust\n'
  else
    printf '  admin-domain trust still present; remove it with:\n' >&2
    printf '    sudo security remove-trusted-cert -d "%s"\n' "$CA_CRT" >&2
  fi
fi
if security_timeout delete-certificate -c "$CA_CN" "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1; then
  printf '  removed from the login keychain\n'
else
  printf '  login-keychain certificate not removed automatically\n'
fi

if ca_in_system_keychain; then
  if sudo -n true >/dev/null 2>&1; then
    sudo -n security delete-certificate -c "$CA_CN" /Library/Keychains/System.keychain >/dev/null 2>&1 || true
    printf '  removed from the System keychain\n'
  else
    printf '  System keychain still contains the CA; remove it with:\n' >&2
    printf '    sudo security delete-certificate -c "%s" /Library/Keychains/System.keychain\n' "$CA_CN" >&2
  fi
fi

if [ "$REMOVE_KEY" = "1" ]; then
  security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1 || true
  printf 'removed Soniox key from Keychain\n'
else
  printf 'kept Soniox key in Keychain (use --remove-key to delete)\n'
fi

if [ "$REMOVE_CERTS" = "1" ]; then
  rm -rf "$CERT_DIR"
  printf 'removed %s\n' "$CERT_DIR"
else
  printf 'kept certificates in %s\n' "$CERT_DIR"
fi

printf 'teardown complete\n'
