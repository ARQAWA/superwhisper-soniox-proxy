#!/bin/bash
# Create/refresh a SuperWhisper mode that uses the built-in Nova 3 voice model
# and enables realtime output, then make it the active mode.
#
# SuperWhisper must be closed while its files are edited: otherwise the app can
# write its in-memory settings back on quit and overwrite the changes.
set -euo pipefail

APP_DOMAIN="${APP_DOMAIN:-com.superduper.superwhisper}"
MODE_KEY="${MODE_KEY:-soniox-target}"
MODE_NAME="${MODE_NAME:-Soniox Target}"
LANGUAGE="${LANGUAGE:-ru}"
VOICE_MODEL_ID="${VOICE_MODEL_ID:-sw-deepgram-nova-3}"
TEMPLATE_MODE="${TEMPLATE_MODE:-message}"
NO_RESTART="${NO_RESTART:-0}"
DOCS_DIR="${SUPERWHISPER_DOCS_DIR:-$HOME/Documents/superwhisper}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

require_cmd jq
require_cmd defaults

if [ ! -d "$DOCS_DIR/modes" ]; then
  printf 'SuperWhisper modes directory not found; opening SuperWhisper once...\n'
  open -a SuperWhisper >/dev/null 2>&1 || true
  sleep 6
fi
if [ ! -d "$DOCS_DIR/modes" ]; then
  printf 'SuperWhisper modes directory not found: %s\n' "$DOCS_DIR/modes" >&2
  printf 'Open SuperWhisper once, then re-run this script.\n' >&2
  exit 1
fi

template_path=""
if [ -f "$DOCS_DIR/modes/$TEMPLATE_MODE.json" ]; then
  template_path="$DOCS_DIR/modes/$TEMPLATE_MODE.json"
else
  template_path="$(find "$DOCS_DIR/modes" -maxdepth 1 -name '*.json' ! -name "$MODE_KEY.json" | head -n 1)"
fi

printf 'closing SuperWhisper before editing settings...\n'
osascript -e 'tell application "superwhisper" to quit' >/dev/null 2>&1 || true
sleep 2

tmp_mode="$(mktemp "$DOCS_DIR/modes/.$MODE_KEY.XXXXXX")"
if [ -n "$template_path" ] && [ -f "$template_path" ]; then
  jq \
    --arg key "$MODE_KEY" \
    --arg name "$MODE_NAME" \
    --arg model "$VOICE_MODEL_ID" \
    --arg language "$LANGUAGE" \
    '.key = $key
     | .name = $name
     | .type = "voice"
     | .voiceModelID = $model
     | .language = $language
     | .languageModelID = ""
     | .realtimeOutput = true
     | .diarize = false
     | .prompt = ""
     | .promptExamples = []
     | .description = ""' \
    "$template_path" >"$tmp_mode"
else
  printf 'no mode JSON to copy; creating a minimal mode from scratch\n' >&2
  jq -n \
    --arg key "$MODE_KEY" \
    --arg name "$MODE_NAME" \
    --arg model "$VOICE_MODEL_ID" \
    --arg language "$LANGUAGE" \
    '{activationApps: [], activationSites: [], autocapitalizeInsert: false,
      contextFromActiveApplication: false, contextFromClipboard: false,
      contextFromSelection: false,
      contextTemplate: "Use the copied text as context to complete this task.\n\nCopied text: ",
      description: "", diarize: false, iconName: "", key: $key, language: $language,
      languageModelID: "", literalPunctuation: false, name: $name, prompt: "",
      promptExamples: [], realtimeOutput: true, script: "", scriptEnabled: false,
      tone: "casual", translateToEnglish: false, type: "voice",
      useSystemAudio: false, version: 1, voiceModelID: $model}' >"$tmp_mode"
fi
mv "$tmp_mode" "$DOCS_DIR/modes/$MODE_KEY.json"

settings="$DOCS_DIR/settings/settings.json"
if [ -f "$settings" ]; then
  tmp_settings="$(mktemp "$DOCS_DIR/settings/.settings.XXXXXX")"
  jq --arg key "$MODE_KEY" '.modeKeys = (((.modeKeys // []) + [$key]) | unique)' \
    "$settings" >"$tmp_settings"
  mv "$tmp_settings" "$settings"
else
  mkdir -p "$DOCS_DIR/settings"
  jq -n --arg key "$MODE_KEY" '{modeKeys: [$key]}' >"$settings"
  printf 'created %s with the mode key\n' "$settings"
fi

defaults write "$APP_DOMAIN" activeModeKey -string "$MODE_KEY"
defaults write "$APP_DOMAIN" lastSelectedModeKey -string "$MODE_KEY"

printf 'mode %s is ready: %s\n' "$MODE_KEY" "$DOCS_DIR/modes/$MODE_KEY.json"
jq '{key, name, voiceModelID, language, realtimeOutput}' "$DOCS_DIR/modes/$MODE_KEY.json"

if [ "$NO_RESTART" = "1" ]; then
  printf 'SuperWhisper left closed (NO_RESTART=1)\n'
  exit 0
fi

open -a SuperWhisper
sleep 3
printf 'SuperWhisper relaunched with %s active\n' "$MODE_KEY"
