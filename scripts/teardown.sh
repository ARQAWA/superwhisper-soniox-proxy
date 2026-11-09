#!/bin/bash
# Reverse the system-level changes made by setup.sh. Keeps certificates and the
# Soniox key by default so a later setup can reuse them.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

REMOVE_KEY=0
REMOVE_CERTS=0

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
if (cd "$ROOT" && bash scripts/stop.sh); then
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1 || true
  if [ -f "$LAUNCHD_PLIST" ] && plist_targets_this_install; then
    rm -f "$LAUNCHD_PLIST"
  else
    printf '  left LaunchAgent plist untouched (not owned by this installation)\n'
  fi
else
  printf '  left LaunchAgent and plist untouched because the stop refused or failed\n'
fi

printf 'restoring macOS secure web proxy\n'
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
  stored_service="$(state_read NETWORK_SERVICE)"
  stored_enabled="$(state_read PREVIOUS_ENABLED)"
  stored_server="$(state_read PREVIOUS_SERVER)"
  stored_port="$(state_read PREVIOUS_PORT)"
  if [ -n "$stored_service" ]; then
    NETWORK_SERVICE="$stored_service"
  fi
  PREVIOUS_ENABLED="${stored_enabled:-No}"
  PREVIOUS_SERVER="$stored_server"
  PREVIOUS_PORT="${stored_port:-0}"
  if [ "${PREVIOUS_ENABLED:-No}" = "Yes" ] && [ -n "${PREVIOUS_SERVER:-}" ] && [ "${PREVIOUS_PORT:-0}" != "0" ]; then
    networksetup -setsecurewebproxy "$NETWORK_SERVICE" "$PREVIOUS_SERVER" "$PREVIOUS_PORT"
    networksetup -setsecurewebproxystate "$NETWORK_SERVICE" on
    printf '  restored previous proxy %s:%s\n' "$PREVIOUS_SERVER" "$PREVIOUS_PORT"
  else
    networksetup -setsecurewebproxystate "$NETWORK_SERVICE" off
    printf '  disabled secure web proxy\n'
  fi
  rm -f "$STATE_FILE"
else
  networksetup -setsecurewebproxystate "$NETWORK_SERVICE" off
  printf '  disabled secure web proxy\n'
fi

printf 'removing local CA trust\n'
CA_HASH=""
CA_OLD_HASHES=""
if [ -f "$CERT_DIR/.ca-renewal-old-hash" ]; then
  CA_OLD_HASHES="$(cat "$CERT_DIR/.ca-renewal-old-hash" 2>/dev/null || true)"
fi
if [ -f "$CA_CRT" ]; then
  CA_HASH="$(openssl x509 -in "$CA_CRT" -noout -fingerprint -sha1 2>/dev/null \
    | sed 's/^.*=//; s/://g' || true)"
fi
remove_user_trust() {
  local cert="$1" err
  err="$(mktemp "${TMPDIR:-/tmp}/soniox-trust.XXXXXX")" || return 2
  if security_timeout remove-trusted-cert "$cert" 2>"$err"; then
    rm -f "$err"
    return 0
  fi
  if grep -qi 'could not be found' "$err"; then
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  return 2
}

remove_admin_trust() {
  local cert="$1" err
  if ! sudo -n true >/dev/null 2>&1; then
    return 2
  fi
  err="$(mktemp "${TMPDIR:-/tmp}/soniox-trust.XXXXXX")" || return 2
  if sudo -n security remove-trusted-cert -d "$cert" 2>"$err"; then
    rm -f "$err"
    return 0
  fi
  if grep -qi 'could not be found' "$err"; then
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  return 2
}

USER_TRUST_PENDING=0
remove_user_trust "$CA_CRT" && trust_rc=0 || trust_rc=$?
if [ "$trust_rc" = "0" ]; then
  printf '  removed user-domain trust\n'
elif [ "$trust_rc" = "2" ]; then
  USER_TRUST_PENDING=1
  printf '  user-domain trust not removed automatically (it may require Keychain authorization)\n'
fi
for old_crt in "$CERT_DIR"/.ca-renewal-old-*.crt; do
  if [ ! -f "$old_crt" ]; then
    continue
  fi
  remove_user_trust "$old_crt" && trust_rc=0 || trust_rc=$?
  if [ "$trust_rc" = "0" ]; then
    printf '  removed user-domain trust for a replaced root\n'
  elif [ "$trust_rc" = "2" ]; then
    USER_TRUST_PENDING=1
    printf '  user-domain trust for a replaced root not removed; run:\n' >&2
    printf '    security remove-trusted-cert "%s"\n' "$old_crt" >&2
  fi
done

ADMIN_TRUST_PENDING=0
remove_admin_trust "$CA_CRT" && trust_rc=0 || trust_rc=$?
if [ "$trust_rc" = "0" ]; then
  printf '  removed admin-domain trust\n'
elif [ "$trust_rc" = "2" ]; then
  ADMIN_TRUST_PENDING=1
  printf '  admin-domain trust not removed automatically; remove it with:\n' >&2
  printf '    sudo security remove-trusted-cert -d "%s"\n' "$CA_CRT" >&2
fi
for old_crt in "$CERT_DIR"/.ca-renewal-old-*.crt; do
  if [ ! -f "$old_crt" ]; then
    continue
  fi
  remove_admin_trust "$old_crt" && trust_rc=0 || trust_rc=$?
  if [ "$trust_rc" = "0" ]; then
    printf '  removed admin-domain trust for a replaced root\n'
  elif [ "$trust_rc" = "2" ]; then
    ADMIN_TRUST_PENDING=1
    printf '    sudo security remove-trusted-cert -d "%s"\n' "$old_crt" >&2
  fi
done
if [ -n "$CA_HASH" ] && security_timeout delete-certificate -t -Z "$CA_HASH" "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1; then
  printf '  removed from the login keychain\n'
else
  printf '  login-keychain certificate not removed automatically\n'
fi
if [ -n "$CA_OLD_HASHES" ]; then
  for old_hash in $CA_OLD_HASHES; do
    if [ "$old_hash" = "$CA_HASH" ]; then
      continue
    fi
    security_timeout delete-certificate -t -Z "$old_hash" "$HOME/Library/Keychains/login.keychain-db" \
      >/dev/null 2>&1 || true
  done
fi

if [ -n "$CA_HASH" ] || [ -n "$CA_OLD_HASHES" ]; then
  if sudo -n true >/dev/null 2>&1; then
    if [ -n "$CA_HASH" ]; then
      sudo -n security delete-certificate -t -Z "$CA_HASH" /Library/Keychains/System.keychain >/dev/null 2>&1 || true
    fi
    if [ -n "$CA_OLD_HASHES" ]; then
      for old_hash in $CA_OLD_HASHES; do
        if [ "$old_hash" = "$CA_HASH" ]; then
          continue
        fi
        sudo -n security delete-certificate -t -Z "$old_hash" /Library/Keychains/System.keychain >/dev/null 2>&1 || true
      done
    fi
    printf '  attempted System-keychain removal by fingerprint\n'
  else
    printf '  System keychain may still contain the CA; remove it with:\n' >&2
    if [ -n "$CA_HASH" ]; then
      printf '    sudo security delete-certificate -Z "%s" /Library/Keychains/System.keychain\n' "$CA_HASH" >&2
    fi
    if [ -n "$CA_OLD_HASHES" ]; then
      for old_hash in $CA_OLD_HASHES; do
        if [ "$old_hash" = "$CA_HASH" ]; then
          continue
        fi
        printf '    sudo security delete-certificate -Z "%s" /Library/Keychains/System.keychain\n' "$old_hash" >&2
      done
    fi
  fi
else
  printf '  the local CA certificate is missing, so its fingerprint is unavailable; remove the certificate manually\n' >&2
fi

if [ "$REMOVE_KEY" = "1" ]; then
  security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1 || true
  printf 'removed Soniox key from Keychain\n'
else
  printf 'kept Soniox key in Keychain (use --remove-key to delete)\n'
fi

if [ "$REMOVE_CERTS" = "1" ]; then
  if [ -n "$CA_HASH" ]; then
    touch "$CERT_DIR/.ca-renewal-old-hash"
    grep -qx "$CA_HASH" "$CERT_DIR/.ca-renewal-old-hash" 2>/dev/null \
      || printf '%s\n' "$CA_HASH" >>"$CERT_DIR/.ca-renewal-old-hash"
  fi
  for entry in "$CERT_DIR"/* "$CERT_DIR"/.[!.]* "$CERT_DIR"/..?*; do
    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then
      continue
    fi
    case "$entry" in
      */.ca-renewal-old-hash) continue ;;
      */.ca-renewal-old-*.crt)
        if [ "$USER_TRUST_PENDING" = "1" ] || [ "$ADMIN_TRUST_PENDING" = "1" ]; then
          continue
        fi
        ;;
    esac
    if [ "$USER_TRUST_PENDING" = "1" ] || [ "$ADMIN_TRUST_PENDING" = "1" ]; then
      if [ "$entry" = "$CA_CRT" ]; then
        continue
      fi
    fi
    rm -rf "$entry"
  done
  if [ "$USER_TRUST_PENDING" = "1" ] || [ "$ADMIN_TRUST_PENDING" = "1" ]; then
    printf 'kept %s until its trust is removed\n' "$CA_CRT"
  fi
  printf 'removed certificates from %s (kept replacement fingerprint history)\n' "$CERT_DIR"
else
  printf 'kept certificates in %s\n' "$CERT_DIR"
fi

printf 'teardown complete\n'
