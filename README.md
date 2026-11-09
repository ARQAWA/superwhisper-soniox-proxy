# SuperWhisper → Soniox local proxy

A local TypeScript proxy that lets **SuperWhisper 3.2.1** use **Soniox STT v6** for its built-in **Nova 3** voice model, including realtime dictation. SuperWhisper itself is not patched: the proxy is selected through the normal macOS HTTPS proxy setting, and the app keeps passing its own code-signature checks.

## What works

- **Batch** (`POST https://api.deepgram.com/v1/listen`, `model=nova-3`) is answered by Soniox `stt-async-v6` with a Deepgram-shaped JSON response.
- **Realtime** (`wss://api.deepgram.com/v1/listen`, the app sends `model=nova-2` for Nova 3 modes) is bridged to Soniox `stt-rt-v6` and streamed back as Deepgram `Results` messages.
- **Scribe** (`wss://api.elevenlabs.io/v1/speech-to-text/realtime`, the app's `sw-elevenlabs-scribe` mode) is forwarded live. Every partial and `committed_transcript` is relayed without batch buffering or suppression, so the app receives the final before its own close timeout.
- **Pass-through** for every other host, path, and model is unchanged. `api.superwhisper.com` model/license traffic and non-target Deepgram models still work.
- Target audio is **never forwarded to Deepgram**. Logs record `upstream_forwarded=false` for intercepted requests.
- The proxy listens on loopback only (`127.0.0.1:8443` and `[::1]:8443`).

## Architecture

```
SuperWhisper
   │  system HTTPS proxy 127.0.0.1:8443
   ▼
local proxy (Node/TypeScript)
   ├─ batch  /v1/listen + model=nova-3              → Soniox stt-async-v6
   ├─ realtime /v1/listen (WS, target mode)         → Soniox stt-rt-v6
   ├─ realtime /v1/speech-to-text/realtime         → ElevenLabs Scribe (live)
   └─ everything else                               → real upstream over TLS
```

A local CA signs the leaf certificate for `api.deepgram.com`, `api.superwhisper.com`, and `api.elevenlabs.io`, so no `/etc/hosts` change or privileged port is needed. The app is untouched and SIP remains enabled.

## Install on a new Mac

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh | bash
```

The installer handles Homebrew dependencies, the Keychain key prompt, the local CA, the LaunchAgent, the system proxy, and the SuperWhisper mode. See [`INSTALL.md`](INSTALL.md) for details, update/uninstall steps, and troubleshooting.

Re-run the same command to upgrade an old install. The current installer requires a clean checkout on the requested branch and only fast-forwards it. It rebuilds `dist/`, verifies certificates, and applies the `0.5 s` Scribe profile without changing existing SuperWhisper modes or Soniox LaunchAgent settings. Download the current installer first; an old installed copy may still reset local changes: `curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh -o /tmp/install.sh && bash /tmp/install.sh --upgrade`.

## Requirements

- macOS with SuperWhisper 3.2.1 installed
- Node.js >= 22
- pnpm
- OpenSSL, `jq`, `curl`, `security`, `networksetup`
- A Soniox API key with realtime + async STT permissions

## Quick start

From the repository root:

```bash
bash install.sh
```

What setup does:

1. Installs dependencies and builds `dist/`.
2. Creates or renews `certs/` only when needed.
3. Stores the Soniox key in Keychain under service `soniox-proxy`, account `SONIOX_API_KEY` (the proxy reads it from there; no key is written to the repo).
4. Checks the exact CA and leaf trust, prompting for trust if needed.
5. Starts the proxy as a LaunchAgent (or `nohup` without `--launchd`).
6. Enables the Wi-Fi secure web proxy pointing at `127.0.0.1:8443`.
7. Creates missing target modes without changing existing modes or their active selection.
8. `start-fast.sh` applies the `0.5 s` Scribe profile and preserves existing Soniox LaunchAgent settings.
9. With `--smoke`, runs the batch, pass-through, and realtime checks.

Then in SuperWhisper select **Soniox Target** and dictate. The batch path and the realtime path should both use Soniox.

### Manual setup

```bash
pnpm install
pnpm build
bash scripts/gen-certs.sh                       # if certs are missing
security add-generic-password -U -s soniox-proxy -a SONIOX_API_KEY -w "$SONIOX_API_KEY"
security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db certs/ca.crt
networksetup -setsecurewebproxy Wi-Fi 127.0.0.1 8443
networksetup -setsecurewebproxystate Wi-Fi on
bash scripts/start-fast.sh
bash scripts/health.sh
```

### LaunchAgent instead of nohup

```bash
bash scripts/install-launchd.sh
```

The GitHub installer uses a **LaunchAgent by default** and stops on setup failures. Use `--no-launchd` explicitly for `nohup`. A local `scripts/setup.sh` run uses `nohup` unless you pass `--launchd`. The agent runs Node from this directory, writes logs to `logs/`, and reads the Soniox key from Keychain.

## Verification

```bash
bash scripts/health.sh            # proxy, CA, key, system proxy, signature, SIP
bash scripts/smoke-target.sh      # batch through Soniox (no transcript printed)
bash scripts/smoke-passthrough.sh # raw CONNECT + MITM pass-through
node scripts/smoke-realtime.mjs   # realtime, 85 chars / 11 words, no truncation
SMOKE_LONG=1 node scripts/smoke-realtime.mjs  # adds a 2 s pause; 172 chars / 22 words, both repetitions verified
pnpm test                         # unit tests
```

The smoke commands send audio or network requests; run them only with the user's permission.

Scribe is checked through the app: select **Scribe Target**, dictate at least 30 seconds in a quiet room, then compare the saved transcript with the spoken text. The proxy must log `scribe ws upstream open` and relay the final `committed_transcript`; it must not buffer or synthesize finals, and it must not log transcript text.

`scripts/smoke-realtime.mjs` prints only lengths, word counts, and message counts. It never prints transcript text.

## Diagnostics

Every proxy start writes private telemetry outside the repository:

```text
~/Library/Caches/soniox-proxy/diagnostics/
├── meta.json                 # pid, start time, retention, thresholds
├── summary.jsonl             # one line per realtime/batch request
├── anomalies.jsonl           # only suspicious events
├── request-parameters.jsonl  # Scribe query and Soniox SDK settings
└── sessions/YYYY-MM-DD/      # per-stream JSONL timelines
```

The realtime trace records connect time, audio frame counts and gaps, Soniox result counts and processing progress, `CloseStream`, finalization latency, the final result size, and the client close code. The summary gives every stream a status such as `ok`, `client_closed_before_final`, `connect_failed`, or `final_sent_after_safety_net`.

Session telemetry stores counts, lengths, timings, and close codes. The private parameter log also records Scribe query settings and the Soniox SDK input object, not a captured Soniox wire frame. Tokens, recognized sensitive fields, and user-specific keyterms are redacted; audio frames and response transcripts are not recorded. Directory mode is `700`, files are `600`.

Review old sessions:

```bash
bash scripts/diagnostics.sh
jq -c 'select(.status != "ok")' ~/Library/Caches/soniox-proxy/diagnostics/summary.jsonl | tail -20
jq -c . ~/Library/Caches/soniox-proxy/diagnostics/anomalies.jsonl | tail -20
```

Session trace retention defaults to 14 days and at most 2000 files. `DIAG_ENABLED=false` disables session telemetry, but not `request-parameters.jsonl`; that file persists until removed. Move the directory with `DIAG_DIR`.

## Configuration

Environment variables (all optional; defaults in `src/config.ts`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROXY_HOST` / `PROXY_PORT` | `127.0.0.1` / `8443` | Loopback listener |
| `TARGET_HOST` | `api.deepgram.com` | Intercepted host |
| `TARGET_PATH` | `/v1/listen` | Intercepted batch path |
| `TARGET_MODEL` | `nova-3` | Batch model value |
| `TARGET_VOICE_MODEL_ID` | `sw-deepgram-nova-3` | SuperWhisper voice model ID |
| `TARGET_MODE_KEY` | `soniox-target` | SuperWhisper mode used for realtime detection |
| `TARGET_REALTIME_QUERY_MODELS` | `nova-2,nova-3` | Query models that may belong to the target mode |
| `WS_MODE` | `soniox` | `soniox` or `passthrough` |
| `ALLOW_TARGET_WS_PASSTHROUGH` | `false` | Safety gate; keep false |
| `WS_CLOSE_DELAY_MS` | `350` | Delay before the bridge closes the socket after the final result |
| `SCRIBE_ENABLED` | `true` | Intercept the Scribe realtime socket for the active Scribe mode |
| `SCRIBE_HOST` | `api.elevenlabs.io` | Scribe upstream host |
| `SCRIBE_PATH` | `/v1/speech-to-text/realtime` | Scribe realtime path |
| `SCRIBE_VOICE_MODEL_ID` | `sw-elevenlabs-scribe` | SuperWhisper voice model ID |
| `SCRIBE_MODEL` | `scribe_v2_realtime` | Expected upstream realtime model |
| `SCRIBE_VAD_TUNING` | `true` | Rewrite Scribe VAD query parameters for VAD commits |
| `SCRIBE_VAD_SILENCE_THRESHOLD_SECS` | `1.5` | Silence before a VAD commit, `0.192`–`3.0` |
| `SCRIBE_VAD_THRESHOLD` | `0.4` | Scribe speech-detection threshold, `0.1`–`0.9` |
| `SCRIBE_MIN_SPEECH_DURATION_MS` | `100` | Minimum Scribe speech segment, `50`–`2000` |
| `SCRIBE_MIN_SILENCE_DURATION_MS` | `100` | Minimum Scribe silence break, `50`–`2000` |
| `SONIOX_MODEL` | `stt-async-v6` | Batch model |
| `SONIOX_REALTIME_MODEL` | `stt-rt-v6` | Realtime model |
| `SONIOX_ENDPOINT_DETECTION` | `true` | Soniox semantic endpointing; disabled automatically for diarization |
| `SONIOX_ENDPOINT_SENSITIVITY` | `0` | Endpoint likelihood, `-1.0` to `1.0` |
| `SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL` | `0` | Endpoint latency profile, `0`–`3` |
| `SONIOX_MAX_ENDPOINT_DELAY_MS` | `2000` | Hard upper bound after speech ends, `500`–`3000` |
| `SONIOX_KEEPALIVE_MS` | `10000` | Send Soniox keepalive after this much audio silence; `0` disables |
| `SONIOX_PREFIX_BATCH_CONNECT_MS` | `1200` | If Soniox connects slower, send queued audio through batch instead of a burst (`0` disables) |
| `SONIOX_RECONNECT_LAG_MS` | `4000` | Reconnect when Soniox is this far behind live audio |
| `SONIOX_RECONNECT_MAX` | `3` | Maximum reconnect attempts per dictation |
| `SONIOX_RECONNECT_OVERLAP_MS` | `500` | Audio overlap replayed after reconnect |
| `SONIOX_CLOSE_ERROR_LAG_MS` | `2000` | At `CloseStream`, start full batch recovery if Soniox is this far behind |
| `SONIOX_CLOSE_BATCH_DELAY_MS` | `1000` | If no final arrives, start full batch recovery after this delay |
| `SONIOX_CLOSE_RECOVERY_MS` | `15000` | Max time to wait for full batch recovery before returning an error |
| `SONIOX_LANGUAGE_HINTS` | `ru,en` | Fallback language hints |
| `SONIOX_MAX_CONCURRENCY` | `2` | Batch concurrency |
| `DRY_RUN` | `false` | Capture/pass-through instead of interception |
| `CAPTURE_TEMPLATE` | `false` | Write a sanitized response template |
| `LOG_LEVEL` | `info` | `debug` adds message sizes/types, never text |
| `DIAG_ENABLED` | `true` | Per-stream JSONL telemetry |
| `DIAG_DIR` | `~/Library/Caches/soniox-proxy/diagnostics` | Telemetry directory |
| `DIAG_RETENTION_DAYS` | `14` | Trace retention (1–365) |
| `DIAG_AUDIO_GAP_MS` | `1500` | Log audio-frame gaps above this |
| `DIAG_RESULT_GAP_MS` | `8000` | Log Soniox result gaps above this |
| `DIAG_AUDIO_LAG_MS` | `3000` | Flag when Soniox processed this much less audio than received |
| `DIAG_CLOSE_TIMEOUT_MS` | `1500` | Flag finalization slower than this after `CloseStream` |
| `CERT_DIR` / `LOG_DIR` | `./certs` / `./logs` | Local paths |

Key lookup order: `SONIOX_API_KEY` environment → Keychain (`soniox-proxy` / `SONIOX_API_KEY`) → `~/.config/soniox-proxy/api-key` (must be mode `600`).

## Realtime details

SuperWhisper sends its realtime request with `model=nova-2` even when the selected voice model is Nova 3. The proxy therefore reads the active mode from `defaults read com.superduper.superwhisper activeModeKey` and the mode JSON (`voiceModelID === sw-deepgram-nova-3`). This is why you should not switch modes in the middle of a recording.

Soniox returns subword pieces and periodically drops the prefix that it has already finalized. The bridge:

1. accumulates finalized tokens across a session,
2. merges subword pieces into whole words,
3. streams growing interim `Results` messages,
4. sends one final `Results` segment when the app sends `CloseStream`,
5. ends with a `Metadata` message and closes the socket after a short delay (`WS_CLOSE_DELAY_MS`, default 350 ms) so the app can render the final text.

Endpoint detection is enabled by default with Soniox's conservative settings (`endpoint_sensitivity=0`, `endpoint_latency_adjustment_level=0`, `max_endpoint_delay_ms=2000`). Soniox finalizes pending tokens at natural pauses, which shortens the CloseStream tail; it is disabled automatically when `diarize=true`, because Soniox documents that endpointing reduces diarization accuracy. `SONIOX_ENDPOINT_DETECTION=false` restores the old single-segment behavior. For lower latency at a small accuracy risk, use Soniox's recommended starting point: `SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL=2`, `SONIOX_ENDPOINT_SENSITIVITY=0.3`, and optionally `SONIOX_MAX_ENDPOINT_DELAY_MS=1500`.

If no binary audio frame arrives for `SONIOX_KEEPALIVE_MS` (default 10 s), the bridge sends Soniox's `{"type":"keepalive"}` control. Soniox ends an audio-idle stream after 20 s; this preserves context through a long pause. Soniox bills the full stream duration, so a kept-open stream still accrues cost; set `SONIOX_KEEPALIVE_MS=0` to disable this behavior.

At `CloseStream`, the bridge uses Soniox's graceful empty-text finish and waits for the `finished` response. It does not send a manual `finalize` at close; the app's own `Finalize` control is forwarded when present.

### Cost and reliability tradeoffs

| Choice | Gain | Cost or risk |
| --- | --- | --- |
| Endpoint detection on, conservative defaults | Final tokens sooner; shorter CloseStream tail | Soniox may finalize slightly earlier, with a small recognition-accuracy risk |
| Endpoint level `2`, sensitivity `0.3`, max `1500` | Lower endpoint latency than the defaults | More segments and a larger accuracy risk; opt-in only |
| Endpoint off for diarization | Best diarization accuracy | No endpoint latency benefit |
| Keepalive every 10 s | Survives pauses longer than Soniox's 20 s audio timeout | Billed stream duration continues while the pause lasts |
| Prefix batch after a slow handshake | Prevents a large queued burst from leaving realtime permanently behind | Duplicate async cost for the queued prefix; measured 8 of 114 sessions before this tuning |
| Reconnect on sustained lag | Recovers a live stream that is behind | New realtime stream plus overlap; duplicates a short span |
| Full batch recovery at close | Never sends a partial final | Duplicates the whole recording with async STT; only on failure |
| `SONIOX_PREFIX_BATCH_CONNECT_MS=0`, `SONIOX_RECONNECT_MAX=0` | Minimum calls | Tail-loss risk when the handshake or live stream stalls |

Soniox's public pay-as-you-go rates are about `$0.12/hour` realtime and `$0.10/hour` async. The reliability fallbacks therefore add only a small premium when they trigger; they are retained because the app closes about 1.5 s after stop and a lost tail cannot be recovered later.

### Balanced profile

`bash scripts/start-fast.sh` applies Scribe VAD silence `0.5 s`, threshold `0.4`, and minimum speech/silence durations of `100 ms`. It creates missing target modes, but leaves existing modes, their selected language and audio source, and the active selection unchanged. Existing Soniox LaunchAgent settings are retained.

The `0.5 s` threshold appears in an [ElevenLabs example](https://elevenlabs.io/docs/eleven-api/resources/libraries/scribe-stt/react-scribe); it is a starting point, not a guarantee of equal Soniox latency or accuracy. Scribe finalizes based on silence, whereas [Soniox also uses semantic endpointing](https://docs.soniox.com/stt/rt/endpoint-detection). Earlier finalization may split speech at shorter pauses.

New LaunchAgents start with Soniox's documented lower-latency example: level `2`, sensitivity `0.3`, and maximum delay `1500 ms`. Existing agent values are not overwritten. The Scribe profile is persisted in the owned LaunchAgent; a nohup-only setup applies until logout or reboot.

The app folder is detected from SuperWhisper's configured location, with support for both `~/superwhisper` and the older `~/Documents/superwhisper`. `SUPERWHISPER_DOCS_DIR` can override detection for scripts and the proxy.

If the Soniox WebSocket handshake takes longer than `SONIOX_PREFIX_BATCH_CONNECT_MS` (default 1200 ms), the audio queued during the handshake is transcribed with `stt-async-v6` instead of being burst into the realtime session. The realtime session then starts at the live edge. A burst would leave Soniox permanently behind live audio, and the app closes before the tail is finalized. The prefix tokens are prepended to the same transcript, with live token timestamps shifted by the prefix duration. Diagnostics record `prefix_batch_*` events and `prefix_missing_at_final` if the prefix is still pending at close.

The bridge never sends a partial final. If Soniox is more than `SONIOX_RECONNECT_LAG_MS` behind live audio, it closes the current realtime session, opens a new one, and replays buffered audio from the last safely finalized token (`SONIOX_RECONNECT_OVERLAP_MS` overlap). At `CloseStream`, if the realtime session is still behind or does not finish within `SONIOX_CLOSE_BATCH_DELAY_MS`, the proxy transcribes the **entire recording** with `stt-async-v6` and keeps its side of the app socket open with empty interim `Results` for up to `SONIOX_CLOSE_RECOVERY_MS`. Only the full batch transcript is sent as the final segment. If recovery fails or times out, the proxy clears the live interim, closes with code `1011`, and the app can use its own retry/batch fallback instead of pasting truncated text. **Unverified:** whether SuperWhisper resets its ~1.5 s post-`CloseStream` timeout when it receives those empty interims is not yet proven with the real app. If it closes first, the proxy cannot deliver the recovered final; diagnostics record `client_closed_during_recovery` for that case.

## Scribe details

When the active mode is **Scribe Target** (`sw-elevenlabs-scribe`), the app opens `wss://api.elevenlabs.io/v1/speech-to-text/realtime` with `commit_strategy=vad` and a single-use `token` query parameter. The proxy forwards partial, committed, edited, and diagnostic messages unchanged.

For `commit_strategy=vad`, the installed profile sets `vad_silence_threshold_secs=0.5`, `vad_threshold=0.4`, `min_speech_duration_ms=100`, and `min_silence_duration_ms=100`. Manual and turn-prediction VAD parameters are not rewritten. `SCRIBE_VAD_TUNING=false` leaves the app's VAD parameters unchanged; the raw `src/config.ts` fallback remains `1.5 s`.

For every Scribe realtime session, the proxy sets `no_verbatim=false` so Scribe is not instructed to remove filler words. It preserves the selected language and other query parameters. SuperWhisper's separate language-model processing can still edit the text.

The proxy deliberately does not batch, buffer, or suppress Scribe messages. The app closes about 1.5 s after stop, before a batch final can arrive; a batch result also cannot reach a closed client. Suppressing upstream finals therefore lost text. Forwarding the upstream `committed_transcript` is the reliable path. The only queue is the short upstream WebSocket handshake; frames are forwarded immediately after it opens. The app's own Scribe final is the transcript; the proxy adds no synthetic final.

While Scribe is active, other ElevenLabs HTTP requests and responses are streamed through instead of buffered or size-limited.

A 42 s Russian smoke test delivered the final sentence before the app closed. The microphone also transcribed a nearby voice message, so final checks must run in a quiet room. Live text is never written to logs.

## Security and privacy

- The listener is loopback-only. No LAN or external interface is opened.
- Target audio is sent only to Soniox. Batch requests are never forwarded to Deepgram; realtime target sockets never open an upstream Deepgram connection.
- No audio, transcript text, `Authorization`, cookies, API keys, or query values for `keyterm`/`keywords`/`prompt` are logged. `redactQuery()` in `src/url-utils.ts` keeps protocol parameters and redacts user-specific ones.
- Session diagnostics contain sizes, counts, timings, codes, and IDs. The private request-parameter log also contains recognition settings; see Diagnostics.
- The Soniox key lives in Keychain. `certs/` and `logs/` are in `.gitignore`.
- The local CA private key is mode `600`. Certificates are local-only; new roots default to 365 days. Setup checks expiry, key matching, leaf hostnames, and actual trust before starting the proxy.
- SuperWhisper is not modified. `codesign --verify --deep --strict /Applications/SuperWhisper.app` passes and SIP is enabled.

## Teardown

```bash
bash scripts/teardown.sh                 # stops proxy, disables system proxy, removes CA trust
bash scripts/teardown.sh --remove-key    # also deletes the Soniox key from Keychain
bash scripts/teardown.sh --remove-certs  # deletes certs/ but keeps replacement fingerprints
```

If the CA was installed in the System keychain, teardown prints the `sudo` commands needed to remove it. Certificates and the key are kept by default so setup can be re-run quickly.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| App says it cannot connect / TLS error | `bash scripts/health.sh`; re-run `scripts/setup.sh` then `scripts/start-fast.sh` after trust changes |
| Batch works, realtime falls back to batch | `tail -f logs/proxy.log` for `soniox realtime connected`, `CloseStream`, `finished`; confirm active mode is `soniox-target` |
| Realtime text looks truncated | Run `SMOKE_LONG=1 node scripts/smoke-realtime.mjs`; it must report `final_length >= max_interim_length` |
| Periodic hang or cut at the end | `bash scripts/diagnostics.sh`; check `client_closed_before_final`, `close_to_finish_ms`, `close_text_length` vs `final_text_length` |
| Pass-through broken | `bash scripts/smoke-passthrough.sh`; check `network`/DNS and the system proxy setting |
| CA expired | `bash scripts/setup.sh --no-install --skip-proxy --launchd`, then `bash scripts/start-fast.sh` (renews, re-trusts, and restores the profile) |
| Port already in use | `lsof -nP -iTCP:8443 -sTCP:LISTEN`; stop the old proxy with `scripts/stop.sh` |

## Known limitations

- **Batch latency**: Soniox async transcription p95 is around 4.1 s on the test machine, above the original 3 s target. This is upstream processing time, not proxy overhead.
- **App coupling**: target detection depends on SuperWhisper's current mode JSON and its realtime query using `model=nova-2`/`nova-3`. A future app update may change the wire format; re-run the recon procedure in that case.
- **Certificates**: setup renews a root or leaf when needed; trust approval can require user interaction.
- **LaunchAgent Keychain access** depends on the login session; nohup is the default and most predictable mode.
