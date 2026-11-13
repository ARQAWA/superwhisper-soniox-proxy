# SuperWhisper → Soniox local proxy

> **AI agents: read [`AI_AGENT_READ_ME_FIRST_INSTALL_PROMPT.md`](AI_AGENT_READ_ME_FIRST_INSTALL_PROMPT.md) first.**

> For a short install and update checklist, see [`INSTALL.md`](INSTALL.md).

A local TypeScript proxy that lets **SuperWhisper 3.2.1** use **Soniox STT v6** for its built-in **Nova 3** voice model, including realtime dictation. SuperWhisper itself is not patched: the proxy is selected through the normal macOS HTTPS proxy setting, and the app keeps passing its own code-signature checks.

## What works

- **Batch** (`POST https://api.deepgram.com/v1/listen`, `model=nova-3`) is answered by Soniox `stt-async-v6` with a Deepgram-shaped JSON response.
- **Realtime** (`wss://api.deepgram.com/v1/listen`, the app sends `model=nova-2` for Nova 3 modes) is bridged to Soniox `stt-rt-v6` and streamed back as Deepgram `Results` messages.
- **Scribe realtime** (`wss://api.elevenlabs.io/v1/speech-to-text/realtime`, the app's `sw-elevenlabs-scribe` mode) is forwarded live. Every partial and `committed_transcript` is relayed without batch buffering or suppression, so the app receives the final before its own close timeout.
- **Scribe file mode** (`POST https://api.superwhisper.com/elevenlabs/v1/transcribe`) is intercepted. The proxy keeps verbatim output (`no_verbatim=false`), removes the paid `keyterms[]` field, keeps the language, diarization, and audio, and forwards the upload to SuperWhisper.
- **Pass-through** for every other host, path, and model is unchanged. `api.superwhisper.com` model/license traffic and non-target Deepgram models still work.
- Target audio is **never forwarded to Deepgram**. Logs record `upstream_forwarded=false` for intercepted requests.
- The proxy listens on loopback only (`127.0.0.1:8443` and `[::1]:8443`).

## Architecture

```
SuperWhisper
   │  macOS PAC: only allowlisted hosts -> 127.0.0.1:8443
   ▼
local proxy (Node/TypeScript)
   ├─ batch  /v1/listen + model=nova-3              → Soniox stt-async-v6
   ├─ realtime /v1/listen (WS, nova-2/nova-3)       → Soniox stt-rt-v6
   ├─ realtime /v1/speech-to-text/realtime         → ElevenLabs Scribe (live)
   ├─ batch    /elevenlabs/v1/transcribe           → SuperWhisper → ElevenLabs
   └─ everything else                               → real upstream over TLS
```

A local CA signs the leaf certificate for `api.deepgram.com`, `api.superwhisper.com`, and `api.elevenlabs.io`, so no `/etc/hosts` change or privileged port is needed. The app is untouched and SIP remains enabled.

## Install on a new Mac

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh | bash
```

The installer handles Homebrew dependencies, the Keychain key prompt, the local CA, the LaunchAgent, and the system proxy. It never reads or modifies SuperWhisper. See [`AI_AGENT_READ_ME_FIRST_INSTALL_PROMPT.md`](AI_AGENT_READ_ME_FIRST_INSTALL_PROMPT.md) for details, update/uninstall steps, and troubleshooting.

For a copy-paste checklist that another machine or agent can follow, see
[`INSTALL.md`](INSTALL.md).

Re-run the same command to upgrade an old install. The current installer requires a clean checkout on the requested branch and only fast-forwards it. It rebuilds `dist/`, verifies certificates, and applies the quality profile. It never touches SuperWhisper. Download the current installer first; an old installed copy may still reset local changes: `curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh -o /tmp/install.sh && bash /tmp/install.sh --upgrade`.

For a clean reinstall that removes the old checkout and rewrites the proxy
recognition prompt:

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh -o /tmp/install.sh
bash /tmp/install.sh --clean
```

The clean path backs up the old `~/.config/soniox-proxy/context.json`.
It keeps the Soniox key and certificates.
It never touches SuperWhisper, its modes, or its settings.

## Requirements

- macOS; SuperWhisper 3.2.1 installed if you want to use the proxy
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
6. Enables a Wi-Fi PAC proxy pointing at `127.0.0.1:8443`.
   Only the allowlisted
   SuperWhisper, Scribe, ElevenLabs, and Soniox hosts go through the proxy.
   Every other request stays direct.
7. Writes the managed recognition prompt to `~/.config/soniox-proxy/context.json`.
8. Does not read or modify SuperWhisper.
9. `start-fast.sh` applies the quality profile: strict single-language Soniox,
   a free-text Soniox prompt, verbatim Scribe output, and a `1 s` Scribe VAD.
10. With `--smoke`, runs the batch, pass-through, and realtime checks.

Create or select a SuperWhisper mode yourself.
Use the built-in **Nova 3** voice model for Soniox.
Use the built-in **Scribe** voice model for Scribe.
The proxy routes those requests by host, path, and model only.

### Manual setup

```bash
pnpm install
pnpm build
bash scripts/gen-certs.sh                       # if certs are missing
security add-generic-password -U -s soniox-proxy -a SONIOX_API_KEY -w "$SONIOX_API_KEY"
security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db certs/ca.crt
node dist/src/pac-cli.js --host 127.0.0.1 --port 8443 \
  --hosts api.superwhisper.com,api.deepgram.com,api.elevenlabs.io,api.soniox.com \
  --out logs/proxy.pac
networksetup -setsecurewebproxystate Wi-Fi off
networksetup -setautoproxyurl Wi-Fi "http://127.0.0.1:8443/proxy.pac"
networksetup -setautoproxystate Wi-Fi on
bash scripts/configure-soniox-context.sh
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

Scribe is checked through the app: select a mode that uses the built-in **Scribe** voice model, dictate at least 30 seconds in a quiet room, then compare the saved transcript with the spoken text. The proxy must log `scribe ws upstream open` and relay the final `committed_transcript`; it must not buffer or synthesize finals, and it must not log transcript text.

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
| `PROXY_ALLOWED_HOSTS` | `api.superwhisper.com,api.deepgram.com,api.elevenlabs.io,api.soniox.com` | Hosts routed through the proxy; everything else stays direct |
| `PAC_PATH` | `./logs/proxy.pac` | Generated PAC file used by the macOS proxy setting |
| `TARGET_HOST` | `api.deepgram.com` | Intercepted host |
| `TARGET_PATH` | `/v1/listen` | Intercepted batch path |
| `TARGET_MODEL` | `nova-3` | Batch model value |
| `TARGET_VOICE_MODEL_ID` | `sw-deepgram-nova-3` | Status label only |
| `TARGET_REALTIME_QUERY_MODELS` | `nova-2,nova-3` | Realtime query models intercepted for Soniox |
| `WS_MODE` | `soniox` | `soniox` or `passthrough` |
| `ALLOW_TARGET_WS_PASSTHROUGH` | `false` | Safety gate; keep false |
| `WS_CLOSE_DELAY_MS` | `350` | Delay before the bridge closes the socket after the final result |
| `SCRIBE_ENABLED` | `true` | Intercept the Scribe realtime socket |
| `SCRIBE_HOST` | `api.elevenlabs.io` | Scribe upstream host |
| `SCRIBE_PATH` | `/v1/speech-to-text/realtime` | Scribe realtime path |
| `SCRIBE_VOICE_MODEL_ID` | `sw-elevenlabs-scribe` | Status label only |
| `SCRIBE_MODEL` | `scribe_v2_realtime` | Expected upstream realtime model |
| `SCRIBE_VERBATIM` | `true` | Keep filler words and repetitions (`no_verbatim=false`); keyterms are always removed |
| `SUPERWHISPER_HOST` | `api.superwhisper.com` | Host that carries the Scribe file upload |
| `SCRIBE_BATCH_ENABLED` | `true` | Intercept the Scribe file upload |
| `SCRIBE_BATCH_PATH` | `/elevenlabs/v1/transcribe` | Scribe file-mode path |
| `SCRIBE_VAD_TUNING` | `true` | Rewrite Scribe VAD query parameters for VAD commits |
| `SCRIBE_VAD_SILENCE_THRESHOLD_SECS` | `1` | Silence before a VAD commit, `0.192`–`3.0` |
| `SCRIBE_VAD_THRESHOLD` | `0.4` | Scribe speech-detection threshold, `0.1`–`0.9` |
| `SCRIBE_MIN_SPEECH_DURATION_MS` | `100` | Minimum Scribe speech segment, `50`–`2000` |
| `SCRIBE_MIN_SILENCE_DURATION_MS` | `100` | Minimum Scribe silence break, `50`–`2000` |
| `SONIOX_MODEL` | `stt-async-v6` | Batch model |
| `SONIOX_REALTIME_MODEL` | `stt-rt-v6` | Realtime model |
| `SONIOX_ENDPOINT_DETECTION` | `true` | Soniox semantic endpointing; disabled automatically for diarization |
| `SONIOX_ENDPOINT_SENSITIVITY` | `-1` | Endpoint likelihood, `-1.0` to `1.0`; lower waits for more context |
| `SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL` | `0` | Endpoint latency profile, `0`–`3` |
| `SONIOX_MAX_ENDPOINT_DELAY_MS` | `3000` | Hard upper bound after speech ends, `500`–`3000` |
| `SONIOX_KEEPALIVE_MS` | `10000` | Send Soniox keepalive after this much audio silence; `0` disables |
| `SONIOX_PREFIX_BATCH_CONNECT_MS` | `1200` | If Soniox connects slower, send queued audio through batch instead of a burst (`0` disables) |
| `SONIOX_RECONNECT_LAG_MS` | `4000` | Reconnect when Soniox is this far behind live audio |
| `SONIOX_RECONNECT_MAX` | `3` | Maximum reconnect attempts per dictation |
| `SONIOX_RECONNECT_OVERLAP_MS` | `500` | Audio overlap replayed after reconnect |
| `SONIOX_CLOSE_ERROR_LAG_MS` | `2000` | At `CloseStream`, start full batch recovery if Soniox is this far behind |
| `SONIOX_CLOSE_BATCH_DELAY_MS` | `1000` | If no final arrives, start full batch recovery after this delay |
| `SONIOX_CLOSE_RECOVERY_MS` | `15000` | Max time to wait for full batch recovery before returning an error |
| `SONIOX_LANGUAGE_HINTS` | `ru,en` | Fallback language hints |
| `SONIOX_LANGUAGE_HINTS_STRICT` | `true` | Use `language_hints_strict` when there is one explicit hint |
| `SONIOX_AUTO_LANGUAGE` | `hi` | Picker sentinel that switches Soniox to automatic language detection |
| `SONIOX_CONTEXT_FILE` | `~/.config/soniox-proxy/context.json` | Free-text recognition prompt |
| `SONIOX_CONTEXT_TEXT` | empty | Extra context text from the environment |
| `SONIOX_API_BASE_URL` | `https://api.soniox.com` | Soniox REST base used by the warm fetch adapter |
| `SONIOX_REALTIME_HOST` | `stt-rt.soniox.com` | Soniox realtime host kept warm |
| `WARMUP_ENABLED` | `true` | Keep one warm connection per provider |
| `WARMUP_INTERVAL_MS` | `30000` | Warm connection probe interval |
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

SuperWhisper sends its realtime request with `model=nova-2` even when the selected voice model is Nova 3. The proxy intercepts a realtime request when the host is `TARGET_HOST` and the query model is in `TARGET_REALTIME_QUERY_MODELS` (`nova-2,nova-3`). It does not read SuperWhisper settings, defaults, modes, or files.

Soniox returns subword pieces and periodically drops the prefix that it has already finalized. The bridge:

1. accumulates finalized tokens across a session,
2. merges subword pieces into whole words,
3. streams growing interim `Results` messages,
4. sends one final `Results` segment when the app sends `CloseStream`,
5. ends with a `Metadata` message and closes the socket after a short delay (`WS_CLOSE_DELAY_MS`, default 350 ms) so the app can render the final text.

Endpoint detection is enabled by default with Soniox's quality-first settings (`endpoint_sensitivity=-1`, `endpoint_latency_adjustment_level=0`, `max_endpoint_delay_ms=3000`). Soniox finalizes pending tokens at natural pauses, which shortens the CloseStream tail; it is disabled automatically when `diarize=true`, because Soniox documents that endpointing reduces diarization accuracy. `SONIOX_ENDPOINT_DETECTION=false` restores the old single-segment behavior. For lower latency at a small accuracy risk, use Soniox's recommended starting point: `SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL=2`, `SONIOX_ENDPOINT_SENSITIVITY=0.3`, and optionally `SONIOX_MAX_ENDPOINT_DELAY_MS=1500`.

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

### Quality profile

`bash scripts/start-fast.sh` applies the quality profile.
Scribe uses `no_verbatim=false`, `vad_silence_threshold_secs=1`, `vad_threshold=0.4`, and
minimum speech/silence durations of `100 ms`. SuperWhisper closes its Scribe
socket about `1.5 s` after the user stops, so the provider default of `1.5 s`
leaves no room for the final commit. One second keeps that margin without the
`0.5 s` fragmentation that glued words together.
The proxy strips every `keyterms`/`keyterms[]` parameter from realtime and
file-mode Scribe, because keyterm prompting is billed separately.

Soniox uses `endpoint_sensitivity=-1`, `endpoint_latency_adjustment_level=0`,
and `max_endpoint_delay_ms=3000`, more conservative than the defaults from the
[Soniox endpoint documentation](https://docs.soniox.com/stt/rt/endpoint-detection).
This profile favors recognition accuracy over latency: the model waits for
more context before committing a segment and splits speech into fewer pieces.
At `CloseStream` the bridge calls Soniox's graceful finish and waits for the
final result, so the longer endpoint delay does not strand the tail.
When the request has one explicit language hint (`ru`), the proxy also sends
`language_hints_strict=true`, following Soniox's single-language guidance.
Automatic and multi-language requests stay non-strict.

The Nova picker has no automatic option. Select Hindi (`hi`) and the proxy
omits language hints while enabling Soniox language identification. Set
`SONIOX_AUTO_LANGUAGE` to use a different sentinel.

The managed prompt in `~/.config/soniox-proxy/context.json` is sent as Soniox
`context`. Only its free-text `text` is used; `terms` and `general` are ignored
because provider term lists were rewriting ordinary words. Edit `text`, then
re-run `start-fast.sh`. The proxy does not read SuperWhisper's mode prompt, so a
translation or writing prompt cannot leak into recognition.

Batch and realtime share one recognition configuration: same language hints,
strictness, language identification, diarization, and prompt. Only the model
differs (`stt-async-v6` for files, `stt-rt-v6` for live audio).

At startup, and every `WARMUP_INTERVAL_MS`, the proxy keeps one keep-alive
connection to `api.soniox.com`, `api.elevenlabs.io`, and
`api.superwhisper.com`. The Scribe WebSocket reuses the warm ElevenLabs socket,
and Soniox REST calls go through the warm fetch adapter, so the first request
after a restart does not pay for DNS or a TLS handshake.

The same values are written to the owned LaunchAgent. A nohup-only setup applies
until logout or reboot. The proxy never reads or modifies SuperWhisper.

If the Soniox WebSocket handshake takes longer than `SONIOX_PREFIX_BATCH_CONNECT_MS` (default 1200 ms), the audio queued during the handshake is transcribed with `stt-async-v6` instead of being burst into the realtime session. The realtime session then starts at the live edge. A burst would leave Soniox permanently behind live audio, and the app closes before the tail is finalized. The prefix tokens are prepended to the same transcript, with live token timestamps shifted by the prefix duration. Diagnostics record `prefix_batch_*` events and `prefix_missing_at_final` if the prefix is still pending at close.

The bridge never sends a partial final. If Soniox is more than `SONIOX_RECONNECT_LAG_MS` behind live audio, it closes the current realtime session, opens a new one, and replays buffered audio from the last safely finalized token (`SONIOX_RECONNECT_OVERLAP_MS` overlap). At `CloseStream`, if the realtime session is still behind or does not finish within `SONIOX_CLOSE_BATCH_DELAY_MS`, the proxy transcribes the **entire recording** with `stt-async-v6` and keeps its side of the app socket open with empty interim `Results` for up to `SONIOX_CLOSE_RECOVERY_MS`. Only the full batch transcript is sent as the final segment. If recovery fails or times out, the proxy clears the live interim, closes with code `1011`, and the app can use its own retry/batch fallback instead of pasting truncated text. **Unverified:** whether SuperWhisper resets its ~1.5 s post-`CloseStream` timeout when it receives those empty interims is not yet proven with the real app. If it closes first, the proxy cannot deliver the recovered final; diagnostics record `client_closed_during_recovery` for that case.

## Scribe details

When SuperWhisper opens the Scribe realtime path, it uses `wss://api.elevenlabs.io/v1/speech-to-text/realtime` with `commit_strategy=vad` and a single-use `token` query parameter. The proxy forwards partial, committed, edited, and diagnostic messages unchanged.

For `commit_strategy=vad`, the installed profile sets `vad_silence_threshold_secs=1`, `vad_threshold=0.4`, `min_speech_duration_ms=100`, and `min_silence_duration_ms=100`. The silence value is below the provider default of `1.5 s` so the last sentence is committed before the app closes. Manual and turn-prediction VAD parameters are not rewritten. `SCRIBE_VAD_TUNING=false` leaves the app's VAD parameters unchanged.

The proxy removes every `keyterms`/`keyterms[]` parameter from the Scribe
socket, because keyterm prompting is billed separately.

Every Scribe socket logs `audio_frames`, `audio_bytes`, and `silence_before_close_ms`. If `silence_before_close_ms` is close to `1500`, the app is waiting for a final commit that has not arrived yet; a smaller `vad_silence_threshold_secs` moves the commit earlier.

The proxy sets `no_verbatim=false` on every Scribe socket so filler words,
false starts, and repetitions are kept. It preserves the selected language and
every other query parameter. Set `SCRIBE_VERBATIM=false` to ask Scribe for
cleanup instead. SuperWhisper's separate language-model processing can still
edit the text.

## Scribe file mode

SuperWhisper's non-realtime Scribe path is
`POST https://api.superwhisper.com/elevenlabs/v1/transcribe`, a multipart upload
with `language_code`, `no_verbatim`, `keyterms[]`, `diarize`, and an `audio`
part. The proxy MITMs `api.superwhisper.com`, removes `keyterms[]` and
sets `no_verbatim=false`. It keeps the language, diarization, and audio, then
forwards the upload. Without an explicit `no_verbatim`, Scribe falls back to
cleanup and deletes fillers and repeated words. SuperWhisper's own backend
still talks to ElevenLabs, so the proxy never needs an ElevenLabs key.
Non-transcribe traffic on that host is streamed through.

The proxy deliberately does not batch, buffer, or suppress Scribe messages. The app closes about 2.5 s after the last audio frame (measured 2026-11-09), before a batch final could arrive; a batch result also cannot reach a closed client. Suppressing upstream finals therefore lost text. Forwarding the upstream `committed_transcript` is the reliable path. The only queue is the short upstream WebSocket handshake; frames are forwarded immediately after it opens. The app's own Scribe final is the transcript; the proxy adds no synthetic final.

For the Scribe and SuperWhisper hosts, other HTTP requests and responses are streamed through instead of buffered or size-limited.

A 42 s Russian smoke test delivered the final sentence before the app closed. The microphone also transcribed a nearby voice message, so final checks must run in a quiet room. Live text is never written to logs.

## Security and privacy

- The listener is loopback-only. No LAN or external interface is opened.
- Target audio is sent only to Soniox. Batch requests are never forwarded to Deepgram; realtime target sockets never open an upstream Deepgram connection.
- No audio, transcript text, `Authorization`, cookies, API keys, or query values for `keyterm`/`keywords`/`prompt` are logged. `redactQuery()` in `src/url-utils.ts` keeps protocol parameters and redacts user-specific ones.
- Session diagnostics contain sizes, counts, timings, codes, and IDs. The private request-parameter log also contains recognition settings; see Diagnostics.
- The Soniox key lives in Keychain. `certs/` and `logs/` are in `.gitignore`.
- The local CA private key is mode `600`. Certificates are local-only; new roots default to 365 days. Setup checks expiry, key matching, leaf hostnames, and actual trust before starting the proxy.
- The proxy never reads or modifies SuperWhisper files, defaults, modes, or settings.

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
| Batch works, realtime falls back to batch | `tail -f logs/proxy.log` for `soniox realtime connected`, `CloseStream`, `finished`; confirm the realtime request model is `nova-2` or `nova-3` |
| Realtime text looks truncated | Run `SMOKE_LONG=1 node scripts/smoke-realtime.mjs`; it must report `final_length >= max_interim_length` |
| Periodic hang or cut at the end | `bash scripts/diagnostics.sh`; check `client_closed_before_final`, `close_to_finish_ms`, `close_text_length` vs `final_text_length` |
| Pass-through broken | `bash scripts/smoke-passthrough.sh`; check `network`/DNS and the system proxy setting |
| CA expired | `bash scripts/setup.sh --no-install --skip-proxy --launchd`, then `bash scripts/start-fast.sh` (renews, re-trusts, and restores the profile) |
| Port already in use | `lsof -nP -iTCP:8443 -sTCP:LISTEN`; stop the old proxy with `scripts/stop.sh` |

## Known limitations

- **Batch latency**: Soniox async transcription p95 is around 4.1 s on the test machine, above the original 3 s target. This is upstream processing time, not proxy overhead.
- **Wire coupling**: target detection depends on the realtime query using `model=nova-2`/`nova-3`. A future app update may change the wire format; re-run the recon procedure in that case.
- **Certificates**: setup renews a root or leaf when needed; trust approval can require user interaction.
- **LaunchAgent Keychain access** depends on the login session; nohup is the default and most predictable method.
