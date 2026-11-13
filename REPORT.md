# Implementation report

Date: 2026-11-07
Environment: macOS, SuperWhisper 3.2.1, Node.js 26.7.0, Soniox `stt-async-v6` / `stt-rt-v6`

> **2026-11-10 update:** app configuration and mode detection were removed. The
> installer and proxy never read or modify SuperWhisper. Sections below that
> mention mode files or app defaults are historical recon, not current behavior.

> **2026-11-09 update:** the current install uses a PAC allowlist, Soniox provider defaults, and a `1 s` Scribe VAD. Measurements and health values below are historical evidence from the rounds that produced them.

## Summary

SuperWhisper's built-in **Nova 3** voice model now runs on **Soniox STT v6** through a local TypeScript proxy. Both the batch path and the realtime dictation path are covered. The app binary is unmodified, SIP is enabled, and `codesign --verify --deep --strict` passes.

The proxy is selected by a macOS PAC file (`127.0.0.1:8443/proxy.pac`) that routes only allowlisted hosts. Older rounds below used a system-wide secure web proxy. Target audio never leaves the machine toward Deepgram; non-target traffic and non-target models continue to pass through to their real upstreams.

## What was built

| Component | File | Purpose |
| --- | --- | --- |
| HTTPS MITM proxy | `src/proxy.ts` | Batch interception, pass-through, health endpoint |
| WebSocket bridge | `src/realtime.ts` | Deepgram-compatible realtime stream backed by Soniox |
| Soniox client | `src/soniox.ts` | Async transcription and realtime session creation |
| Deepgram response renderer | `src/template.ts` | Fills the sanitized captured response template |
| Token merger | `src/tokens.ts` | Joins Soniox subwords into whole words; shared by batch/realtime |
| Query redaction | `src/url-utils.ts` | Keeps protocol parameters, hides user-specific values |
| Multipart parser | `src/multipart.ts` | Handles multipart pass-through/target requests |
| Scripts | `scripts/` | Setup, teardown, health, smoke tests, launchd |
| Evidence | `fixtures/`, `docs/recon.md` | Sanitized recon records and templates |

### Batch flow

1. Match `POST https://api.deepgram.com/v1/listen` with `model=nova-3` and an audio body.
2. Send the audio to Soniox `stt-async-v6` with `wait: true`, `interval_ms: 250`, and `cleanup: ["file", "transcription"]`.
3. Merge Soniox subword tokens into whole words.
4. Fill `fixtures/superwhisper-response.template.json` and return it with HTTP 200.
5. Log only IDs, byte sizes, language, latency, and `upstream_forwarded=false`.

### Realtime flow

1. Accept the WSS upgrade on `api.deepgram.com/v1/listen`.
2. Detect target traffic from the query model only (`nova-2`/`nova-3`).
3. Open a Soniox `stt-rt-v6` session with `pcm_s16le`, 16 kHz, mono, endpoint detection on by default (conservative Soniox settings; disabled for diarization).
4. Forward binary PCM frames; handle `CloseStream`, `Finalize`, `KeepAlive`.
5. Accumulate finalized Soniox tokens across the sliding window.
6. Emit Deepgram-shaped interim `Results`, one final `Results` at close, then `Metadata`, then close.
7. Never open an upstream Deepgram socket for target traffic.

## Verification

### Application integrity

```
codesign --verify --deep --strict /Applications/SuperWhisper.app  → exit 0
csrutil status                                                   → enabled
```

No app file or setting is read or modified.

### Batch

- `scripts/smoke-target.sh`: HTTP 200, 85 transcript characters, 11 words, 5.303 s audio, confidence 0.996.
- 20 sequential dictation runs (`fixtures/bench20b.json`):
  - success: **20/20**
  - p50: **2817.5 ms**
  - p95: **4133.1 ms**
  - min: **2682 ms**
  - max: **4191 ms**
- Soniox cleanup check after the runs: **0** `sw-` transcriptions and **0** files remain.

### Realtime

Synthetic PCM streamed through the same WebSocket path:

| Test | Result |
| --- | --- |
| Short phrase | 85 chars, 11 words, 2 final messages (initial empty + final text), 1 `Metadata` |
| Phrase + 2 s pause + phrase | 171 chars, 22 words, `final_length >= max_interim_length`, no drops |
| Phrase + 8 s pause + phrase | 171 chars, 22 words, 0 interim drops, both key words present |
| App dictation with pauses / without pauses | Confirmed complete in the 2026-11-07 run; later intermittent failures showed the realtime stream could lag behind live audio |

End-of-dictation truncation was investigated by replaying the app's own saved recordings through the proxy. For recording `1794041823`, the proxy final was 78 chars / 13 words, exactly matching the app's stored result (78 / 13); for `1794041791`, 141 chars / 24 words versus the app's 140 / 24. The final result was therefore complete. The perceived cut came from the short window between `CloseStream` (when Soniox is still decoding the tail) and the final response. The bridge now keeps the socket open for `WS_CLOSE_DELAY_MS` (350 ms) after the final result so the app can render it before the connection closes.

The app's realtime recordings after the fix completed in 12–66 ms (`processingTime` in `meta.json`), i.e. they used the realtime result and did not fall back to batch.

### Reliability regression and fix (2026-11-08)

Later real sessions showed Soniox falling behind live audio while the app waited for the final. Examples from diagnostics:

| Request | Audio | Close text | Outcome |
| --- | --- | --- | --- |
| `771b5169` | 20.25 s | 133 chars | App closed at ~1.5 s; 149 chars lost from the final |
| `ef90fedc` | 53.14 s | 289 chars | App closed at ~1.5 s; 302 chars lost from the final |
| `0ded010d` | 14.63 s | 73 chars | Lag at close; error `1011` instead of a partial final |

The bridge now applies these rules:

1. Probe lag every second. If Soniox is more than `SONIOX_RECONNECT_LAG_MS` behind for 1.5 s, or the session errors, open a fresh Soniox session and replay buffered audio from the last **safely finalized token** with `SONIOX_RECONNECT_OVERLAP_MS` overlap. The resume point is moved forward to the start of any final token crossing it, so a token/word is never cut: that token is discarded and transcribed again from its beginning. If the 64 MiB audio buffer is incomplete, reconnect/recovery is disabled and the final is not sent.
2. Never send a partial final. If the app is about to stop and the realtime session is behind, silent, or missing its prefix batch, transcribe the full buffered PCM with `stt-async-v6` and keep the proxy side of the socket open with empty interim `Results` until the batch result is ready (`SONIOX_CLOSE_RECOVERY_MS`). Whether SuperWhisper itself waits is not yet verified.
3. If full recovery fails or times out, clear the live interim text and close with code `1011` so the app can take its error path instead of pasting a truncated transcript.

Verification:

- Normal realtime smoke: 85 chars (short) and 171 chars (long with 2 s pause), final length >= longest interim.
- Synthetic boundary harness: a final prefix plus a tail crossing the reconnect point resumed at the crossing token's start, replayed ~2 s, and produced `alpha` + `beta gamma` without dropping `alpha`.
- Synthetic fault harness: session error reconnects and replays audio; lag triggers reconnect; batch fallback returns the full final; forced batch failure closes `1011` with no final.
- Real 21.2 s recording sent faster than real time: realtime lagged, batch recovery returned a 343-character final after 8.1 s, with 11 empty interims sent to a **synthetic WebSocket client**. This proves the proxy side of the hold-open; it does not prove that SuperWhisper resets its own ~1.5 s timeout. No real-app hold-open test has been recorded yet. If SuperWhisper closes first, the proxy cannot deliver a batch final or a `1011`; diagnostics record `client_closed_during_recovery`.
- The deployed proxy was restarted and its health endpoint reports `ws_mode=soniox`.

### Realtime tuning (2026-11-08)

Soniox guidance reviewed: [real-time transcription](https://soniox.com/docs/stt/rt/real-time-transcription), [endpoint detection](https://soniox.com/docs/stt/rt/endpoint-detection), [manual finalization](https://soniox.com/docs/stt/rt/manual-finalization), [connection keepalive](https://soniox.com/docs/stt/rt/connection-keepalive), [WebSocket API](https://docs.soniox.com/api-reference/stt/websocket-api), and [pricing](https://soniox.com/pricing).

Changes:

- Enabled Soniox endpoint detection with its conservative defaults (`endpoint_sensitivity=0`, `endpoint_latency_adjustment_level=0`, `max_endpoint_delay_ms=2000`). The SDK filters `<end>`/`<fin>` tokens, so the app's text contract is unchanged. Endpoint detection is disabled when the app requests diarization, because Soniox documents that it reduces diarization accuracy.
- Added an idle keepalive: after `SONIOX_KEEPALIVE_MS` (default 10 s) without binary audio, the bridge sends `{"type":"keepalive"}`. This prevents Soniox's 20 s audio-idle timeout from ending a paused dictation. The stream stays billable while held open.
- Added `client_reference_id: sw-rt-<requestId>` so realtime requests can be matched with Soniox usage logs.
- Kept the existing slow-handshake prefix batch, sustained-lag reconnect, and full batch recovery. They are the reliability premium; they are not on the normal path.

Verification:

- `pnpm test`: 27 passed; `pnpm build`: passed.
- Short smoke: 85 chars / 11 words; long-with-2 s-pause smoke: 172 chars / 22 words; final length >= longest interim in both. The long smoke also requires a repeated normalized 6-word sequence and reports `repeated_phrase: true`, so both repetitions are present without printing transcript text.
- The long trace records `endpoint_detection=true` and two `soniox_endpoint` events, so endpointing is active without changing the final text.
- 22 s idle smoke with no app audio or app keepalive: two `keepalive_sent` events at 10.2 s and 10.0 s idle, then a complete 85-char / 11-word final. This proves the proxy keeps the Soniox stream alive past its 20 s audio timeout.
- Close-to-finish in the three optimized smokes: 222 ms, 248 ms, and 203 ms; no batch recovery was needed.

The defaults add no per-stream Soniox charge. The fallback cost remains opt-in by failure: before this tuning, diagnostics recorded prefix batches in 8 of 114 sessions and no full batch recoveries or reconnects. See the README tradeoff table for the cost/latency/accuracy alternatives.

### Fast auto diagnosis (2026-11-09)

The active mode was **Soniox Target** with `language=ru`. The realtime bridge was healthy, but Soniox's first result arrived after **1.4-2.1 s** in the last app sessions. The breakdown is roughly 0.7 s WebSocket connect plus model processing; the final itself took 0.2-0.3 s after `CloseStream`.

An auto-language smoke (`language=auto`, language hints `ru,en`) produced the same 85 chars / 11 words, with the first result at **1.369 s**. Auto detection therefore does not remove the first-partial floor.

A direct Soniox test with the undocumented `max_non_final_tokens_duration_ms=360` gained only about 0.1 s, and the installed SDK does not forward that field. It is not used.

The selected recommendation profile is therefore:

- Soniox Target with `language=auto` and microphone input.
- Endpoint level `2`, sensitivity `0.3`, max endpoint delay `1500 ms`.
- Scribe Target with `language=auto`, microphone input, and matching VAD: `1.5 s` silence in that round, threshold `0.4`, `100 ms` minimum speech/silence. The current profile uses `1 s` silence; see README.
- First partial still around 1.4-2.1 s; this is the Soniox floor.
- Scribe is faster but has lower Russian quality.

This is Soniox's documented lower-latency recommendation (`2` / `0.3` / `1500 ms`). Soniox's generic default is `2000 ms`; that is not the active profile. Level `2` / sensitivity `0.3` can split at short pauses and increase false endpoints. Raise the max delay or lower the level if Russian accuracy drops.

`scripts/start-fast.sh` preserves both modes' other settings, applies the auto language and auto-paste, sets the shared endpoint profile, updates an installed LaunchAgent plist, and verifies `/__health` after restart.

An earlier 6.2 s Scribe audio check saved a result, but it contained only the second test phrase and ran on a build before effective-value logging; it verifies forwarding only, not a long-pause close-tail. A later Scribe handshake with the final build logged the effective `vad_silence_threshold_secs=1.5`, `vad_threshold=0.4`, `min_speech_duration_ms=100`, and `min_silence_duration_ms=100`, and the upstream socket opened; no audio was sent, so it verifies the query rewrite, not audio forwarding.

Verification after hardening: the launcher reported `fast profile is active and verified`; `/__health` returned `ws_mode=soniox`, `dry_run=false`, target host `api.deepgram.com`, target path `/v1/listen`, target model `nova-3`, target voice model `sw-deepgram-nova-3`, realtime query models `nova-2,nova-3`, MITM `true`, endpoint detection `true`, level `2`, sensitivity `0.3`, max delay `1500`, Scribe interception `true`, Scribe host `api.elevenlabs.io`, path `/v1/speech-to-text/realtime`, model `scribe_v2_realtime`, and Scribe VAD `1.5` / `0.4` / `100` / `100`; both modes have `language=auto`, `autoPaste=true`, and `useSystemAudio=false`; the listener PID matched the running proxy in both nohup and loaded-agent checks; the auto smoke produced 85 chars / 11 words; the installed LaunchAgent plist contains the same endpoint and Scribe values and no API key; `pnpm test` passed 29 tests and `pnpm build` passed.

### Upgrade cleanup (2026-11-09)

Old installs had two problems: the public installer updated tracked files but left the old `dist/` tree, and re-running `scripts/setup.sh` did not apply the current endpoint profile. An old install could therefore keep a stale compiled proxy and the conservative `2000 ms` defaults.

The upgrade path now:

- Resets the installed checkout to `main` before setup; a plain re-run from the installed checkout now takes this path automatically.
- Removes `dist/` before installing locked dependencies and rebuilding.
- Runs `start-fast.sh` after setup, so both modes and the current `1.5 s` profile are applied.
- Updates existing target modes in place instead of overwriting their prompts and activation rules; both modes use microphone input and auto-paste.
- Stops the old proxy/LaunchAgent through the hardened `stop.sh`, and refuses to overwrite an agent that belongs to another installation.
- Preserves the original pre-install system-proxy state, migrates legacy unquoted state to base64 data, and corrects an older state file that recorded the proxy itself. Setup and teardown parse the state as data, never as shell code.
- Refuses to switch `NETWORK_SERVICE` while a state file exists; run teardown first.
- Rotates an expiring CA with `RENEW_CA=1`, removes only the replaced login-keychain root by SHA-1 fingerprint (including its user trust settings), and re-trusts the new one. Every replacement appends its old fingerprint and certificate for teardown; setup cleanup and teardown both replay the whole history so an interrupted renewal is completed on retry. Teardown keeps the history so failed removals can be retried. A pending `.ca-renewal-pending` marker survives retries, regenerates the leaf, and fails setup until the new/renewed root itself is trusted.
- Prompts for the API key on `/dev/tty` when the installer is piped, without replacing the script's stdin.

Manual checkouts use `git pull --ff-only`, `rm -rf dist`, `pnpm install --frozen-lockfile`, `bash scripts/setup.sh --no-install --skip-proxy --launchd` (to refresh certificates and trust), then `bash scripts/start-fast.sh`. The installer never deletes the Soniox key, diagnostics, or SuperWhisper recordings; it rotates certificates when the CA expires.

### Auto-paste regression (2026-11-09)

After the fast-profile update, SuperWhisper transcribed but did not insert text into the focused app. The active **Soniox Target** mode had `autoPaste=false`, which overrides the global auto-paste setting.

The configurator now sets `autoPaste=true` when it creates or preserves Soniox Target, and `start-fast.sh` rejects the mode if auto-paste is not enabled. The current mode is `autoPaste=true`; the global `autoPasteEnabled` remains true. The user must confirm actual insertion in the focused app.

### Scribe recovery (2026-11-08)

SuperWhisper's **Scribe Target** mode uses `sw-elevenlabs-scribe` and opens `wss://api.elevenlabs.io/v1/speech-to-text/realtime` with `commit_strategy=vad` and a single-use `token` query parameter. The proxy's first recovery version buffered PCM and suppressed upstream `committed_transcript` messages. That was unsafe for this app: it has no `xi-api-key` or `Authorization` header, so the batch request returned HTTP 401 with `invalid_api_key`, and the app closed its socket about 1.5 s after stop, before a batch final could arrive. The saved transcript lost its tail.

The fix is live-only: the proxy forwards partial and committed transcript messages unchanged, including the final `committed_transcript`, and never batches or synthesizes a final. The only queue is the short upstream WebSocket handshake. A batch was tested and rejected because the app closes about 1.5 s after stop; the batch returned HTTP 401 without an `xi-api-key`, and even a slow successful batch cannot reach a closed socket. The app's own query-token flow is the only reliable path.

Verification:

- `pnpm test`: 27 tests passed.
- `pnpm build`: passed.
- Scribe close logs record code and reason byte length only; passthrough and Soniox close logs do the same.
- Other ElevenLabs HTTP requests and responses are streamed through instead of buffered or size-limited while Scribe is active.
- 42.2 s synthetic Russian dictation through the real app and Scribe Target: the final sentence **Финальная проверка хвоста прошла успешно** was present in the saved transcript. A nearby voice message was also captured by the microphone and appended after it; the ambient audio is expected microphone pickup, not a proxy duplication.
- The proxy log for the run no longer reports batch recovery; it logs `scribe ws upstream open`, forwards the final, and does not log transcript text.

### Pass-through

- Raw CONNECT to `example.com`: HTTP 200.
- MITM pass-through on `api.deepgram.com` (non-target path): HTTP 404 from the real service.
- Non-target host `api.superwhisper.com`: HTTP 404 from the real service.
- SuperWhisper model list / license traffic continued to work during manual testing.
- Logs for target requests show `upstream_forwarded=false`; non-target requests show `upstream_forwarded=true`.

### Security and privacy

- Listener is loopback-only.
- `grep` over both log files: **0** hits for sample transcript phrases, **0** hits for `Authorization`/`Bearer`/`cookie`.
- Query logging now keeps protocol parameters (`model`, `language`, flags) and redacts `keyterm`, `keywords`, `prompt`, `context`, tokens, and unknown parameters.
- API key is read from Keychain; it is not in the repo, launchd plist, or logs.
- CA private key is mode `600`; `certs/` and `logs/` are git-ignored.
- Target audio is never forwarded to Deepgram.

## Acceptance criteria

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Nova 3 batch traffic is served by Soniox | Pass |
| 2 | Nova 3 realtime traffic is served by Soniox | Pass |
| 3 | SuperWhisper binary is not patched | Pass |
| 4 | SIP remains enabled | Pass |
| 5 | `codesign --verify --deep --strict` passes | Pass |
| 6 | Target audio is not sent to SuperWhisper/Deepgram | Pass |
| 7 | Non-target traffic/models still work | Pass |
| 8 | No audio, transcript, Authorization, cookie, or key logging | Pass |
| 9 | Setup is repeatable and teardown is reversible | Pass (unprivileged changes are automatic; admin/System keychain removal is printed as a `sudo` command) |
| 10 | Batch success rate 20/20 | Pass |
| 11 | Realtime text is not fragmented, duplicated, or truncated | Pass (token accumulation, word merging, tail handling, 350 ms close delay; user-confirmed) |
| 12 | 5 s dictation batch p95 < 3 s | **Fail**: p95 4.13 s |

Criterion 12 is limited by Soniox async processing latency, not by the proxy. Batch requests are submitted immediately; the remaining time is Soniox queue/processing time. Realtime dictation avoids this latency entirely.

### Quality parity, Scribe file mode, warm connections (2026-11-13)

The recognition path was tightened around one configuration shared by batch and
realtime Soniox calls (`recognitionSettings` in `src/soniox.ts`): same language
hints, `language_hints_strict`, language identification, diarization, and
free-text context. Provider term lists were removed from the context file and
the code ignores `terms` and `general`, because those lists were rewriting
ordinary words. Scribe `keyterms` are stripped because they are billed
separately, and the proxy pins `no_verbatim=false` so Scribe stays verbatim.

Scribe file mode was found in the app binary: it posts multipart audio to
`https://api.superwhisper.com/elevenlabs/v1/transcribe` with `language_code`,
`no_verbatim`, `keyterms[]`, and `diarize`. The proxy now MITMs that host only
while `SCRIBE_BATCH_ENABLED=true`, drops `keyterms[]`, writes
`no_verbatim=false`, keeps the language, diarization, and audio, and forwards
the upload. Other traffic on the host is streamed through.
`SCRIBE_BATCH_ENABLED=false` restores the old raw tunnel.

The proxy keeps one keep-alive connection per provider and probes every
`WARMUP_INTERVAL_MS` (30 s by default). Soniox REST uses a custom fetch adapter
over a keep-alive agent; the Scribe WebSocket reuses the warm ElevenLabs socket.

Verification:

- `pnpm test`: 49 tests pass; `pnpm build`: pass.
- Health reports `scribe_batch_enabled=true`, `warmup_enabled=true`, and warm
  probes with statuses: Soniox API 200, ElevenLabs 404, SuperWhisper 404,
  Soniox realtime host 404. 404 is expected for the bare probe paths.
- `smoke-target.sh` through the new build: HTTP 200, 85 chars, 11 words,
  5.303 s fixture; the Soniox upload, polling, and cleanup all went through the
  warm fetch adapter.
- `smoke-realtime.mjs` through the same build: 85 chars, 11 words, no
  truncation. Batch and realtime now produce the same text on the same fixture.
- A synthetic multipart upload to the Scribe batch path was intercepted and
  logged `dropped_fields=["keyterms[]"]` with `no_verbatim=false`;
  SuperWhisper answered 401 because the test request carried no app auth, as
  expected.
- `api.superwhisper.com` non-transcribe traffic still passed through (404 for
  the bare root).

## Known limitations

- **Batch latency** remains above the 3 s target (p95 ≈ 4.1 s).
- **Wire coupling**: the realtime detection depends on the app sending `model=nova-2`/`nova-3`. A future app update may require re-running recon.
- **Certificate lifetime**: the currently installed CA expires 2026-12-07 (30 days from creation). `scripts/gen-certs.sh` now defaults to 365-day CA / 397-day leaf for future runs. Renew and re-trust before expiry.
- **System keychain**: the CA is also present in the System keychain from the initial manual trust. Teardown removes the login-keychain trust automatically and prints the `sudo` command for the System keychain when it cannot remove it non-interactively. Current app trust was verified through `URLSession`/`security verify-cert` even when explicit trust settings were empty, because the root is present in the login/System keychain.
- **LaunchAgent**: the GitHub installer uses it by default and it was verified on the development Mac (batch and realtime both work through the agent, which reads the key from Keychain). `nohup` remains a fallback for environments where background Keychain access is restricted.

## Teardown

```bash
bash scripts/teardown.sh
```

Stops the proxy/LaunchAgent, disables the PAC proxy (or restores the previous proxy setting if it was captured by `setup.sh`), removes the local CA trust from the login keychain, and leaves certificates plus the Soniox key for a fast re-setup. Add `--remove-key` / `--remove-certs` to delete those too; replacement fingerprint history is retained until those roots are removed, and CA certificates are kept while their user or admin trust still needs manual removal.

## Reproduce

```bash
bash scripts/setup.sh --smoke
bash scripts/health.sh
bash scripts/smoke-target.sh
bash scripts/smoke-passthrough.sh
node scripts/smoke-realtime.mjs
SMOKE_LONG=1 node scripts/smoke-realtime.mjs
pnpm test
```
