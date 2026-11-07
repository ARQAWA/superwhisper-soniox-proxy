#!/bin/bash
# Send the batch fixture through the proxy and validate the Deepgram-shaped
# response without printing the transcript text.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_cmd curl
require_cmd jq

AUDIO="${AUDIO:-$ROOT/fixtures/test-ru.ogg}"
TARGET_MODEL="${TARGET_MODEL:-nova-3}"
LANGUAGE="${LANGUAGE:-ru}"
URL="https://api.deepgram.com/v1/listen?punctuate=true&paragraphs=true&numerals=true&smart_format=true&language=${LANGUAGE}&model=${TARGET_MODEL}"

if [ ! -f "$AUDIO" ]; then
  printf 'missing audio fixture: %s\n' "$AUDIO" >&2
  exit 1
fi
if ! proxy_healthy; then
  printf 'proxy is not healthy at %s\n' "$HEALTH_URL" >&2
  exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

printf 'batch target smoke (%s)\n' "$(basename "$AUDIO")"
result="$(curl -sS --max-time 90 \
  --proxy "http://${PROXY_HOST}:${PROXY_PORT}" \
  --cacert "$CA_CRT" \
  -H 'content-type: audio/ogg' \
  --data-binary "@$AUDIO" \
  -o "$tmp" \
  -w '%{http_code} %{time_total}' \
  "$URL")"
status="${result%% *}"
seconds="${result##* }"

if [ "$status" != "200" ]; then
  printf '  FAIL http %s in %ss\n' "$status" "$seconds" >&2
  head -c 400 "$tmp" >&2 || true
  exit 1
fi

transcript_len="$(jq -r '.results.channels[0].alternatives[0].transcript | length' "$tmp")"
word_count="$(jq -r '.results.channels[0].alternatives[0].words | length' "$tmp")"
duration="$(jq -r '.metadata.duration // 0' "$tmp")"
confidence="$(jq -r '.results.channels[0].alternatives[0].confidence // 0' "$tmp")"

if [ "$transcript_len" -le 0 ] || [ "$word_count" -le 0 ]; then
  printf '  FAIL empty transcript (len=%s words=%s)\n' "$transcript_len" "$word_count" >&2
  exit 1
fi

printf '  ok   http 200 in %ss\n' "$seconds"
printf '  ok   transcript length %s, words %s, duration %ss, confidence %.3f\n' \
  "$transcript_len" "$word_count" "$duration" "$confidence"
