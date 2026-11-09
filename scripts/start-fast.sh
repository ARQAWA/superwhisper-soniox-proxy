#!/bin/bash
# Switch the Soniox Target mode to automatic language detection and restart the
# proxy with the balanced endpoint profile. Also align Scribe Target's mode and
# VAD endpointing with the same 1.5 s target.
#
# This lowers finalization latency at pauses. It does not remove Soniox's
# first-partial floor, which is dominated by the upstream handshake and model.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib.sh"

require_cmd jq
require_cmd curl
require_cmd plutil
require_cmd lsof
require_cmd pnpm
require_cmd defaults

DOCS_DIR="${SUPERWHISPER_DOCS_DIR:-$HOME/Documents/superwhisper}"
MODE_KEY="${MODE_KEY:-soniox-target}"
MODE_PATH="$DOCS_DIR/modes/$MODE_KEY.json"
SCRIBE_MODE_KEY=scribe-target
SCRIBE_MODE_PATH="$DOCS_DIR/modes/$SCRIBE_MODE_KEY.json"
export SUPERWHISPER_DOCS_DIR="$DOCS_DIR"

# The configurator quits the app before deciding compatibility, so an unsaved
# in-memory mode change is flushed and evaluated before any edit or activation.
configure_mode() {
  local key="$1" name="$2" model="$3"
  MODE_KEY="$key" MODE_NAME="$name" VOICE_MODEL_ID="$model" \
  PRESERVE_MODE=1 LANGUAGE=auto NO_RESTART=1 \
    bash scripts/configure-superwhisper-mode.sh
}

# The LaunchAgent runs dist/src/index.js. Remove the old compiled tree first so
# files deleted in a previous version cannot survive the upgrade.
rm -rf "$ROOT/dist"
pnpm build

configure_mode "$SCRIBE_MODE_KEY" "Scribe Target" sw-elevenlabs-scribe
configure_mode "$MODE_KEY" "Soniox Target" sw-deepgram-nova-3

for mode_path in "$SCRIBE_MODE_PATH" "$MODE_PATH"; do
  if ! jq -e '.language == "auto" and .realtimeOutput == true and .diarize == false and .autoPaste == true and .useSystemAudio == false' \
    "$mode_path" >/dev/null; then
    printf 'mode must use language=auto, realtime output, diarize=false, autoPaste=true, and the microphone (useSystemAudio=false): %s\n' "$mode_path" >&2
    exit 1
  fi
done
if ! jq -e '.voiceModelID == "sw-elevenlabs-scribe"' "$SCRIBE_MODE_PATH" >/dev/null; then
  printf 'Scribe Target must use sw-elevenlabs-scribe.\n' >&2
  exit 1
fi
if ! jq -e '.voiceModelID == "sw-deepgram-nova-3"' "$MODE_PATH" >/dev/null; then
  printf 'Soniox Target must use sw-deepgram-nova-3.\n' >&2
  exit 1
fi

# Keep Soniox as the active mode; the two configurator calls both activate.
defaults write com.superduper.superwhisper activeModeKey -string "$MODE_KEY"
defaults write com.superduper.superwhisper lastSelectedModeKey -string "$MODE_KEY"

export WS_MODE=soniox
export DRY_RUN=false
export SONIOX_ENDPOINT_DETECTION=true
export SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL=2
export SONIOX_ENDPOINT_SENSITIVITY=0.3
export SONIOX_MAX_ENDPOINT_DELAY_MS=1500
export SCRIBE_VAD_TUNING=true
export SCRIBE_ENABLED=true
export SCRIBE_HOST=api.elevenlabs.io
export SCRIBE_PATH=/v1/speech-to-text/realtime
export SCRIBE_MODEL=scribe_v2_realtime
export SCRIBE_VOICE_MODEL_ID=sw-elevenlabs-scribe
export SCRIBE_VAD_SILENCE_THRESHOLD_SECS=1.5
export SCRIBE_VAD_THRESHOLD=0.4
export SCRIBE_MIN_SPEECH_DURATION_MS=100
export SCRIBE_MIN_SILENCE_DURATION_MS=100

plist_set_env() {
  local key="$1" value="$2"
  if /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$key" "$LAUNCHD_PLIST" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:$key $value" "$LAUNCHD_PLIST" >/dev/null
  else
    /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:$key string $value" "$LAUNCHD_PLIST" >/dev/null
  fi
}

if launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; then
  if ! launchctl_service_is_this_install; then
    printf 'refusing to edit a loaded LaunchAgent from a different installation\n' >&2
    exit 1
  fi
fi

# Keep the installed login agent in sync with this profile. A nohup process
# cannot survive a reboot; the LaunchAgent is the normal persistent mechanism.
if [ -f "$LAUNCHD_PLIST" ]; then
  if ! plist_targets_this_install; then
    printf 'refusing to edit LaunchAgent for a different installation: %s\n' "$LAUNCHD_PLIST" >&2
    exit 1
  fi
  plist_set_env WS_MODE soniox
  plist_set_env DRY_RUN false
  plist_set_env SONIOX_ENDPOINT_DETECTION true
  plist_set_env SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL 2
  plist_set_env SONIOX_ENDPOINT_SENSITIVITY 0.3
  plist_set_env SONIOX_MAX_ENDPOINT_DELAY_MS 1500
  plist_set_env SCRIBE_VAD_TUNING true
  plist_set_env SCRIBE_ENABLED true
  plist_set_env SCRIBE_HOST api.elevenlabs.io
  plist_set_env SCRIBE_PATH /v1/speech-to-text/realtime
  plist_set_env SCRIBE_MODEL scribe_v2_realtime
  plist_set_env SCRIBE_VOICE_MODEL_ID sw-elevenlabs-scribe
  plist_set_env SCRIBE_VAD_SILENCE_THRESHOLD_SECS 1.5
  plist_set_env SCRIBE_VAD_THRESHOLD 0.4
  plist_set_env SCRIBE_MIN_SPEECH_DURATION_MS 100
  plist_set_env SCRIBE_MIN_SILENCE_DURATION_MS 100
  plutil -lint "$LAUNCHD_PLIST" >/dev/null
fi

launchd_pid() {
  launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null \
    | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\).*/\1/p' \
    | head -n 1
}

bootstrap_agent() {
  local _
  for _ in $(seq 1 20); do
    if launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

profile_health_ok() {
  proxy_health_json | jq -e '
    .ok == true
    and .target_host == "api.deepgram.com"
    and .target_path == "/v1/listen"
    and .target_model == "nova-3"
    and .target_voice_model_id == "sw-deepgram-nova-3"
    and (.target_realtime_query_models | split(",") | map(gsub("^\\s+|\\s+$"; "")) | index("nova-2") != null)
    and .ws_mode == "soniox"
    and .dry_run == false
    and .mitm_enabled == true
    and .soniox_realtime_model == "stt-rt-v6"
    and .soniox_endpoint_detection == true
    and .soniox_endpoint_latency_adjustment_level == 2
    and .soniox_endpoint_sensitivity == 0.3
    and .soniox_max_endpoint_delay_ms == 1500
    and .scribe_vad_tuning == true
    and .scribe_enabled == true
    and .scribe_host == "api.elevenlabs.io"
    and .scribe_path == "/v1/speech-to-text/realtime"
    and .scribe_model == "scribe_v2_realtime"
    and .scribe_voice_model_id == "sw-elevenlabs-scribe"
    and .scribe_vad_silence_threshold_secs == 1.5
    and .scribe_vad_threshold == 0.4
    and .scribe_min_speech_duration_ms == 100
    and .scribe_min_silence_duration_ms == 100
  ' >/dev/null
}

fallback_nohup() {
  printf 'falling back to nohup proxy\n' >&2
  if ! bash scripts/stop.sh; then
    printf 'could not stop the previous proxy; fallback aborted\n' >&2
    exit 1
  fi
  agent_mode=0
  bash scripts/start.sh
}

if launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; then
  [ -f "$LAUNCHD_PLIST" ] || {
    printf 'LaunchAgent is loaded but its plist is missing: %s\n' "$LAUNCHD_PLIST" >&2
    exit 1
  }
  # stop.sh also removes a nohup proxy that may own the port.
  bash scripts/stop.sh
  if bootstrap_agent \
    && launchctl enable "gui/$(id -u)/$LAUNCHD_LABEL" \
    && launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"; then
    agent_mode=1
  else
    printf 'could not start LaunchAgent %s; falling back to nohup\n' "$LAUNCHD_LABEL" >&2
    fallback_nohup
  fi
else
  agent_mode=0
  bash scripts/stop.sh
  bash scripts/start.sh
  if [ -f "$LAUNCHD_PLIST" ]; then
    printf 'updated %s for the next login\n' "$LAUNCHD_PLIST"
  else
    printf 'no LaunchAgent installed; fast profile applies until logout/reboot\n' >&2
  fi
fi

if ! wait_for_health 60 || ! profile_health_ok; then
  if [ "$agent_mode" = "1" ]; then
    printf 'LaunchAgent did not pass the fast-profile checks; falling back to nohup\n' >&2
    fallback_nohup
  fi
fi

if ! wait_for_health 60; then
  printf 'proxy did not become healthy with the fast profile\n' >&2
  exit 1
fi

if launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; then
  running_pid="$(launchd_pid)"
  if ! pid_is_proxy "$running_pid"; then
    printf 'healthy proxy is not the restarted LaunchAgent (pid %s)\n' "${running_pid:-unknown}" >&2
    exit 1
  fi
else
  running_pid="$(proxy_pid)"
  if ! pid_is_proxy "$running_pid"; then
    printf 'healthy proxy is not the nohup proxy (pid %s)\n' "${running_pid:-unknown}" >&2
    exit 1
  fi
fi

listener_pids="$(lsof -nP -iTCP:"$PROXY_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if ! printf '%s\n' "$listener_pids" | grep -qx "$running_pid"; then
  printf 'pid %s does not own the listener on port %s (listeners: %s)\n' \
    "${running_pid:-unknown}" "$PROXY_PORT" "${listener_pids:-none}" >&2
  exit 1
fi

if ! profile_health_ok; then
  printf 'running proxy does not match the fast profile:\n' >&2
  proxy_health_json >&2
  printf '\n' >&2
  exit 1
fi

active_mode="$(defaults read com.superduper.superwhisper activeModeKey 2>/dev/null || true)"
if [ "$active_mode" != "$MODE_KEY" ]; then
  printf 'active mode is %s, expected %s\n' "${active_mode:-unknown}" "$MODE_KEY" >&2
  exit 1
fi

open -a SuperWhisper
sleep 3

printf 'fast profile is active and verified\n'
proxy_health_json
printf '\n'
printf 'SuperWhisper relaunched with %s active\n' "$MODE_KEY"
