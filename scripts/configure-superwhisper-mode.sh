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
PRESERVE_MODE="${PRESERVE_MODE:-0}"
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
require_cmd pgrep

app_running() {
  pgrep -x -i superwhisper >/dev/null 2>&1
}

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
if app_running; then
  osascript -e 'tell application "superwhisper" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 25); do
    if ! app_running; then
      break
    fi
    sleep 0.2
  done
  if app_running; then
    printf 'SuperWhisper did not quit; close it and re-run this script.\n' >&2
    exit 1
  fi
else
  printf 'SuperWhisper is not running\n'
fi

existing_mode="$DOCS_DIR/modes/$MODE_KEY.json"
if [ "$PRESERVE_MODE" = "1" ] && [ -f "$existing_mode" ]; then
  # Re-check after the app exits: SuperWhisper may write an in-memory change
  # back on quit. Do not mutate or activate an incompatible mode.
  if ! jq -e --arg model "$VOICE_MODEL_ID" '.voiceModelID == $model and .realtimeOutput == true and .diarize == false' "$existing_mode" >/dev/null; then
    printf 'refusing to modify or activate an incompatible existing mode: %s\n' "$existing_mode" >&2
    exit 1
  fi
fi

tmp_mode="$(mktemp "$DOCS_DIR/modes/.$MODE_KEY.XXXXXX")"
if [ "$PRESERVE_MODE" = "1" ] && [ -f "$existing_mode" ]; then
  # Update only the language, auto-paste, and audio source. This is used by
  # start-fast.sh so a customized mode keeps its prompt, activation rules, and
  # other settings while both target modes use the same dictation source.
  jq --arg language "$LANGUAGE" '.language = $language | .autoPaste = true | .useSystemAudio = false' "$existing_mode" >"$tmp_mode"
elif [ -n "$template_path" ] && [ -f "$template_path" ]; then
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
     | .autoPaste = true
     | .realtimeOutput = true
     | .diarize = false
     | .useSystemAudio = false
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
      promptExamples: [], autoPaste: true, realtimeOutput: true, script: "", scriptEnabled: false,
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
jq '{key, name, voiceModelID, language, realtimeOutput, autoPaste}' "$DOCS_DIR/modes/$MODE_KEY.json"

if [ "$NO_RESTART" = "1" ]; then
  printf 'SuperWhisper left closed (NO_RESTART=1)\n'
  exit 0
fi

open -a SuperWhisper
sleep 3
printf 'SuperWhisper relaunched with %s active\n' "$MODE_KEY"
