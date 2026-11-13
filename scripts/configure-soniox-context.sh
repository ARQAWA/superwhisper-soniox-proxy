#!/bin/bash
# Install the recognition context prompt for Soniox.
# A clean reinstall replaces the old prompt; a normal upgrade keeps a
# user-edited context file.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

RESET=0
STATUS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    --status) STATUS_ONLY=1 ;;
    -h|--help)
      printf 'Usage: scripts/configure-soniox-context.sh [--reset] [--status]\n'
      exit 0
      ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

require_cmd jq

if [ ! -f "$SONIOX_CONTEXT_PROFILE" ]; then
  printf 'missing context profile: %s\n' "$SONIOX_CONTEXT_PROFILE" >&2
  exit 1
fi
if ! jq -e 'type == "object"' "$SONIOX_CONTEXT_PROFILE" >/dev/null 2>&1; then
  printf 'context profile is not a JSON object: %s\n' "$SONIOX_CONTEXT_PROFILE" >&2
  exit 1
fi

if [ "$STATUS_ONLY" = "1" ]; then
  if [ -f "$SONIOX_CONTEXT_FILE" ] && jq -e 'type == "object"' "$SONIOX_CONTEXT_FILE" >/dev/null 2>&1; then
    jq '{text_chars: (.text // "" | length)}' "$SONIOX_CONTEXT_FILE"
  else
    printf 'context file is missing or invalid: %s\n' "$SONIOX_CONTEXT_FILE" >&2
    exit 1
  fi
  exit 0
fi

if [ -f "$SONIOX_CONTEXT_FILE" ] && [ "$RESET" != "1" ]; then
  printf 'keeping existing context file: %s\n' "$SONIOX_CONTEXT_FILE"
  exit 0
fi

mkdir -p "$(dirname "$SONIOX_CONTEXT_FILE")"
if [ -f "$SONIOX_CONTEXT_FILE" ]; then
  backup="$SONIOX_CONTEXT_FILE.backup-$(date '+%Y%m%d-%H%M%S')"
  cp "$SONIOX_CONTEXT_FILE" "$backup"
  chmod 600 "$backup"
  printf 'old context backed up: %s\n' "$backup"
fi

tmp="$(mktemp "$(dirname "$SONIOX_CONTEXT_FILE")/.context.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
jq '.' "$SONIOX_CONTEXT_PROFILE" >"$tmp"
chmod 600 "$tmp"
mv "$tmp" "$SONIOX_CONTEXT_FILE"
trap - EXIT

printf 'context prompt written: %s\n' "$SONIOX_CONTEXT_FILE"
jq '{text_chars: (.text // "" | length)}' "$SONIOX_CONTEXT_FILE"
