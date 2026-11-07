#!/bin/bash
# Verify that non-target HTTPS traffic still flows through the proxy: both a
# raw CONNECT tunnel (example.com) and a MITM pass-through on the target host
# (api.deepgram.com with no /v1/listen target match).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_cmd curl

check() {
  local label="$1"
  local url="$2"
  local ca_arg="${3:-}"
  local code
  if [ -n "$ca_arg" ]; then
    code="$(curl -sS --max-time 30 --proxy "http://${PROXY_HOST}:${PROXY_PORT}" --cacert "$CA_CRT" \
      -o /dev/null -w '%{http_code}' "$url" || true)"
  else
    code="$(curl -sS --max-time 30 --proxy "http://${PROXY_HOST}:${PROXY_PORT}" \
      -o /dev/null -w '%{http_code}' "$url" || true)"
  fi
  if [ -z "$code" ] || [ "$code" = "000" ] || [ "$code" = "502" ]; then
    printf '  FAIL %s: http %s\n' "$label" "${code:-none}" >&2
    return 1
  fi
  printf '  ok   %s: http %s\n' "$label" "$code"
}

printf 'pass-through smoke\n'
if ! proxy_healthy; then
  printf '  FAIL proxy is not healthy at %s\n' "$HEALTH_URL" >&2
  exit 1
fi

check "raw CONNECT to example.com" "https://example.com/"
check "MITM pass-through on api.deepgram.com" "https://api.deepgram.com/" "ca"
check "non-target host api.superwhisper.com" "https://api.superwhisper.com/"
printf '  note: any HTTP status proves the TLS path; 502/000 would be a proxy failure\n'
