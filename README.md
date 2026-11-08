# SuperWhisper → Soniox local proxy

A local TypeScript proxy that lets **SuperWhisper 3.2.1** use **Soniox STT v6** for its built-in **Nova 3** voice model, including realtime dictation. SuperWhisper itself is not patched: the proxy is selected through the normal macOS HTTPS proxy setting, and the app keeps passing its own code-signature checks.

## What works

- **Batch** (`POST https://api.deepgram.com/v1/listen`, `model=nova-3`) is answered by Soniox `stt-async-v6` with a Deepgram-shaped JSON response.
- **Realtime** (`wss://api.deepgram.com/v1/listen`, the app sends `model=nova-2` for Nova 3 modes) is bridged to Soniox `stt-rt-v6` and streamed back as Deepgram `Results` messages.
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
   └─ everything else                               → real upstream over TLS
```

A local CA signs `api.deepgram.com` / `api.superwhisper.com` leaf certificates for MITM, so no `/etc/hosts` change or privileged port is needed. The CA is trusted for the current user; the app is untouched and SIP remains enabled.

## Install on a new Mac

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh | bash
```

The installer handles Homebrew dependencies, the Keychain key prompt, the local CA, the LaunchAgent, the system proxy, and the SuperWhisper mode. See [`INSTALL.md`](INSTALL.md) for details, update/uninstall steps, and troubleshooting.

## Requirements

- macOS with SuperWhisper 3.2.1 installed
- Node.js >= 22
- pnpm
- OpenSSL, `jq`, `curl`, `security`, `networksetup`
- A Soniox API key with realtime + async STT permissions

## Quick start

From the repository root:

```bash
export SONIOX_API_KEY='...'          # or let setup.sh prompt with hidden input
bash scripts/setup.sh --configure-app --smoke
```

What setup does:

1. Installs dependencies and builds `dist/`.
2. Creates `certs/` (a local CA and leaf certificate) if missing.
3. Stores the Soniox key in Keychain under service `soniox-proxy`, account `SONIOX_API_KEY` (the proxy reads it from there; no key is written to the repo).
4. Adds user trust for the local CA.
5. Starts the proxy with `nohup` (or a LaunchAgent with `--launchd`).
6. Enables the Wi-Fi secure web proxy pointing at `127.0.0.1:8443`.
7. With `--configure-app`, closes SuperWhisper, creates/activates the **Soniox Target** mode (`sw-deepgram-nova-3`, `realtimeOutput=true`), and relaunches it.
8. With `--smoke`, runs the batch, pass-through, and realtime checks.

Then in SuperWhisper select **Soniox Target** and dictate. The batch path and the realtime path should both use Soniox.

### Manual setup

```bash
pnpm install
pnpm build
bash scripts/gen-certs.sh                       # if certs are missing
security add-generic-password -U -s soniox-proxy -a SONIOX_API_KEY -w "$SONIOX_API_KEY"
security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db certs/ca.crt
bash scripts/start.sh
networksetup -setsecurewebproxy Wi-Fi 127.0.0.1 8443
networksetup -setsecurewebproxystate Wi-Fi on
bash scripts/configure-superwhisper-mode.sh
bash scripts/health.sh
```

### LaunchAgent instead of nohup

```bash
bash scripts/install-launchd.sh
```

The GitHub installer uses a **LaunchAgent by default**; it falls back to `nohup` if the agent cannot start. A local `scripts/setup.sh` run uses `nohup` unless you pass `--launchd`. The agent runs `/opt/homebrew/bin/node dist/src/index.js` from this directory, writes logs to `logs/`, and does **not** receive `SONIOX_API_KEY` in its environment; it reads Keychain. If Keychain access is blocked for a background agent, use `bash scripts/setup.sh` (nohup mode).

## Verification

```bash
bash scripts/health.sh            # proxy, CA, key, system proxy, signature, SIP
bash scripts/smoke-target.sh      # batch through Soniox (no transcript printed)
bash scripts/smoke-passthrough.sh # raw CONNECT + MITM pass-through
node scripts/smoke-realtime.mjs   # realtime, 85 chars / 11 words, no truncation
SMOKE_LONG=1 node scripts/smoke-realtime.mjs  # adds a 2 s pause; 171 chars / 22 words
pnpm test                         # unit tests
```

`scripts/smoke-realtime.mjs` prints only lengths, word counts, and message counts. It never prints transcript text.

## Diagnostics

Every proxy start writes private telemetry outside the repository:

```text
~/Library/Caches/soniox-proxy/diagnostics/
├── meta.json                 # pid, start time, retention, thresholds
├── summary.jsonl             # one line per realtime/batch request
├── anomalies.jsonl           # only suspicious events
└── sessions/YYYY-MM-DD/      # per-stream JSONL timelines
```

The realtime trace records connect time, audio frame counts and gaps, Soniox result counts and processing progress, `CloseStream`, finalization latency, the final result size, and the client close code. The summary gives every stream a status such as `ok`, `client_closed_before_final`, `connect_failed`, or `final_sent_after_safety_net`.

Telemetry stores counts, lengths, timings, and close codes only. It never stores audio, transcript text, tokens, keys, `Authorization`, or cookies. Directory mode is `700`, files are `600`.

Review old sessions:

```bash
bash scripts/diagnostics.sh
jq -c 'select(.status != "ok")' ~/Library/Caches/soniox-proxy/diagnostics/summary.jsonl | tail -20
jq -c . ~/Library/Caches/soniox-proxy/diagnostics/anomalies.jsonl | tail -20
```

Retention defaults to 14 days and at most 2000 trace files. Disable with `DIAG_ENABLED=false`, move with `DIAG_DIR`, and tune gap/timeout thresholds with the variables below.

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
| `SONIOX_MODEL` | `stt-async-v6` | Batch model |
| `SONIOX_REALTIME_MODEL` | `stt-rt-v6` | Realtime model |
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

Endpoint detection is disabled so a long dictation is not chopped into tiny final segments. See `src/realtime.ts` and `src/tokens.ts`.

If the Soniox WebSocket handshake takes longer than `SONIOX_PREFIX_BATCH_CONNECT_MS` (default 1200 ms), the audio queued during the handshake is transcribed with `stt-async-v6` instead of being burst into the realtime session. The realtime session then starts at the live edge. A burst would leave Soniox permanently behind live audio, and the app closes before the tail is finalized. The prefix tokens are prepended to the same transcript, with live token timestamps shifted by the prefix duration. Diagnostics record `prefix_batch_*` events and `prefix_missing_at_final` if the prefix is still pending at close.

The bridge never sends a partial final. If Soniox is more than `SONIOX_RECONNECT_LAG_MS` behind live audio, it closes the current realtime session, opens a new one, and replays buffered audio from the last safely finalized token (`SONIOX_RECONNECT_OVERLAP_MS` overlap). At `CloseStream`, if the realtime session is still behind or does not finish within `SONIOX_CLOSE_BATCH_DELAY_MS`, the proxy transcribes the **entire recording** with `stt-async-v6` and keeps its side of the app socket open with empty interim `Results` for up to `SONIOX_CLOSE_RECOVERY_MS`. Only the full batch transcript is sent as the final segment. If recovery fails or times out, the proxy clears the live interim, closes with code `1011`, and the app can use its own retry/batch fallback instead of pasting truncated text. **Unverified:** whether SuperWhisper resets its ~1.5 s post-`CloseStream` timeout when it receives those empty interims is not yet proven with the real app. If it closes first, the proxy cannot deliver the recovered final; diagnostics record `client_closed_during_recovery` for that case.

## Security and privacy

- The listener is loopback-only. No LAN or external interface is opened.
- Target audio is sent only to Soniox. Batch requests are never forwarded to Deepgram; realtime target sockets never open an upstream Deepgram connection.
- No audio, transcript text, `Authorization`, cookies, API keys, or query values for `keyterm`/`keywords`/`prompt` are logged. `redactQuery()` in `src/url-utils.ts` keeps protocol parameters and redacts user-specific ones.
- Diagnostics under `~/Library/Caches/soniox-proxy/` contain only sizes, counts, timings, codes, and IDs; directory mode `700`, files `600`.
- The Soniox key lives in Keychain. `certs/` and `logs/` are in `.gitignore`.
- The local CA private key is mode `600`. Certificates are local-only and currently valid for 30 days (new runs default to 365/397 days); renew with `scripts/gen-certs.sh` and re-trust.
- SuperWhisper is not modified. `codesign --verify --deep --strict /Applications/SuperWhisper.app` passes and SIP is enabled.

## Teardown

```bash
bash scripts/teardown.sh                 # stops proxy, disables system proxy, removes CA trust
bash scripts/teardown.sh --remove-key    # also deletes the Soniox key from Keychain
bash scripts/teardown.sh --remove-certs  # also deletes certs/
```

If the CA was installed in the System keychain, teardown prints the one `sudo` command needed to remove it. Certificates and the key are kept by default so setup can be re-run quickly.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| App says it cannot connect / TLS error | `bash scripts/health.sh`; re-run `scripts/setup.sh` and restart SuperWhisper after trust changes |
| Batch works, realtime falls back to batch | `tail -f logs/proxy.log` for `soniox realtime connected`, `CloseStream`, `finished`; confirm active mode is `soniox-target` |
| Realtime text looks truncated | Run `SMOKE_LONG=1 node scripts/smoke-realtime.mjs`; it must report `final_length >= max_interim_length` |
| Periodic hang or cut at the end | `bash scripts/diagnostics.sh`; check `client_closed_before_final`, `close_to_finish_ms`, `close_text_length` vs `final_text_length` |
| Pass-through broken | `bash scripts/smoke-passthrough.sh`; check `network`/DNS and the system proxy setting |
| CA expired | `bash scripts/gen-certs.sh`, re-trust, restart the app |
| Port already in use | `lsof -nP -iTCP:8443 -sTCP:LISTEN`; stop the old proxy with `scripts/stop.sh` |

## Known limitations

- **Batch latency**: Soniox async transcription p95 is around 4.1 s on the test machine, above the original 3 s target. This is upstream processing time, not proxy overhead.
- **App coupling**: target detection depends on SuperWhisper's current mode JSON and its realtime query using `model=nova-2`/`nova-3`. A future app update may change the wire format; re-run the recon procedure in that case.
- **Certificates**: the CA generated on 2026-11-07 is valid for 30 days. Renew before it expires.
- **LaunchAgent Keychain access** depends on the login session; nohup is the default and most predictable mode.
