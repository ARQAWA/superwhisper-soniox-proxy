#!/bin/bash
# Review retrospective telemetry for realtime dictation and batch requests.
# Prints sizes, timings, codes, and counters only; never transcript text.
set -uo pipefail

DIAG_DIR="${DIAG_DIR:-$HOME/Library/Caches/soniox-proxy/diagnostics}"
LIMIT="${LIMIT:-20}"
SUMMARY="$DIAG_DIR/summary.jsonl"
ANOMALIES="$DIAG_DIR/anomalies.jsonl"

if [ ! -d "$DIAG_DIR" ]; then
  printf 'diagnostics dir not found: %s\n' "$DIAG_DIR" >&2
  printf 'start the proxy once with DIAG_ENABLED=true, then retry.\n' >&2
  exit 1
fi

printf 'diagnostics: %s\n' "$DIAG_DIR"
if [ -f "$DIAG_DIR/meta.json" ]; then
  printf 'process: pid %s, started %s\n' \
    "$(jq -r '.pid // "?"' "$DIAG_DIR/meta.json" 2>/dev/null)" \
    "$(jq -r '.started_at // "?"' "$DIAG_DIR/meta.json" 2>/dev/null)"
fi

printf '\nstatus counts\n'
if [ -f "$SUMMARY" ]; then
  jq -r '.status // "unknown"' "$SUMMARY" | sort | uniq -c | sort -rn
else
  printf '  no summaries yet\n'
fi

printf '\nlast %s non-ok sessions\n' "$LIMIT"
if [ -f "$SUMMARY" ]; then
  jq -r 'select(.status != "ok")
    | [.ended_at, .kind, .status, .request_id,
       (.duration_ms // "-"), (.audio_seconds // "-"),
       (.close_text_length // "-"), (.final_text_length // "-"),
       (.close_to_finish_ms // "-"), (.client_close_code // "-")]
    | @tsv' "$SUMMARY" 2>/dev/null | tail -n "$LIMIT" |
    awk -F'\t' 'BEGIN {
      printf "%-20s %-8s %-26s %-10s %-8s %-7s %-7s %-8s %-8s %-6s\n",
        "ended_at", "kind", "status", "request", "dur_ms", "audio_s", "close", "final", "close_ms", "code"
    } { printf "%-20s %-8s %-26s %-10s %-8s %-7s %-7s %-8s %-8s %-6s\n",
        $1, $2, $3, substr($4,1,8), $5, $6, $7, $8, $9, $10 }'
else
  printf '  no summaries yet\n'
fi

printf '\nlast %s anomalies\n' "$LIMIT"
if [ -f "$ANOMALIES" ]; then
  jq -r '[.at, .kind, (.scope // "-"), .code, (.severity // "-"),
         (.request_id // "-"), (.lost_text_length // "-"),
         (.waited_from_close_ms // "-"), (.close_to_finish_ms // "-")]
    | @tsv' "$ANOMALIES" 2>/dev/null | tail -n "$LIMIT" |
    awk -F'\t' 'BEGIN {
      printf "%-20s %-8s %-12s %-28s %-6s %-10s %-8s %-10s\n",
        "at", "kind", "scope", "code", "sev", "request", "lost", "wait_ms"
    } { printf "%-20s %-8s %-12s %-28s %-6s %-10s %-8s %-10s\n",
        $1, $2, $3, substr($4,1,28), $5, substr($6,1,8), $7, $8 }'
else
  printf '  no anomalies\n'
fi

latest="$(find "$DIAG_DIR/sessions" -type f -name '*.jsonl' 2>/dev/null | sort | tail -n 1)"
if [ -n "$latest" ]; then
  printf '\nlatest trace: %s\n' "$latest"
  printf '  events: '
  jq -r '.event' "$latest" 2>/dev/null | sort | uniq -c | sort -rn | head -12 | tr '\n' ';'
  printf '\n'
fi
