# Implementation report

Date: 2026-11-07
Environment: macOS, SuperWhisper 3.2.1, Node.js 26.7.0, Soniox `stt-async-v6` / `stt-rt-v6`

## Summary

SuperWhisper's built-in **Nova 3** voice model now runs on **Soniox STT v6** through a local TypeScript proxy. Both the batch path and the realtime dictation path are covered. The app binary is unmodified, SIP is enabled, and `codesign --verify --deep --strict` passes.

The proxy is selected by the standard macOS secure web proxy (`127.0.0.1:8443`). Target audio never leaves the machine toward Deepgram; non-target traffic and non-target models continue to pass through to their real upstreams.

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
| Scripts | `scripts/` | Setup, teardown, health, smoke tests, app mode, launchd |
| Evidence | `fixtures/`, `docs/recon.md` | Sanitized recon records and templates |

### Batch flow

1. Match `POST https://api.deepgram.com/v1/listen` with `model=nova-3` and an audio body.
2. Send the audio to Soniox `stt-async-v6` with `wait: true`, `interval_ms: 250`, and `cleanup: ["file", "transcription"]`.
3. Merge Soniox subword tokens into whole words.
4. Fill `fixtures/superwhisper-response.template.json` and return it with HTTP 200.
5. Log only IDs, byte sizes, language, latency, and `upstream_forwarded=false`.

### Realtime flow

1. Accept the WSS upgrade on `api.deepgram.com/v1/listen`.
2. Detect target traffic from the query model plus the active SuperWhisper mode (`sw-deepgram-nova-3`).
3. Open a Soniox `stt-rt-v6` session with `pcm_s16le`, 16 kHz, mono, endpoint detection off.
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

No app file was modified. The mode JSON and macOS proxy settings are outside the app bundle.

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
| App dictation with pauses / without pauses | User confirmed the final text is complete and the earlier end-of-dictation truncation is gone |

End-of-dictation truncation was investigated by replaying the app's own saved recordings through the proxy. For recording `1794041823`, the proxy final was 78 chars / 13 words, exactly matching the app's stored result (78 / 13); for `1794041791`, 141 chars / 24 words versus the app's 140 / 24. The final result was therefore complete. The perceived cut came from the short window between `CloseStream` (when Soniox is still decoding the tail) and the final response. The bridge now keeps the socket open for `WS_CLOSE_DELAY_MS` (350 ms) after the final result so the app can render it before the connection closes.

The app's realtime recordings after the fix completed in 12–66 ms (`processingTime` in `meta.json`), i.e. they used the realtime result and did not fall back to batch.

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

## Known limitations

- **Batch latency** remains above the 3 s target (p95 ≈ 4.1 s).
- **SuperWhisper coupling**: the realtime detection depends on the app sending `model=nova-2`/`nova-3` and on the mode JSON format. A future app update may require re-running recon.
- **Certificate lifetime**: the currently installed CA expires 2026-12-07 (30 days from creation). `scripts/gen-certs.sh` now defaults to 365-day CA / 397-day leaf for future runs. Renew and re-trust before expiry.
- **System keychain**: the CA is also present in the System keychain from the initial manual trust. Teardown removes the login-keychain trust automatically and prints the `sudo` command for the System keychain when it cannot remove it non-interactively. Current app trust was verified through `URLSession`/`security verify-cert` even when explicit trust settings were empty, because the root is present in the login/System keychain.
- **LaunchAgent**: the GitHub installer uses it by default and it was verified on the development Mac (batch and realtime both work through the agent, which reads the key from Keychain). `nohup` remains a fallback for environments where background Keychain access is restricted.

## Teardown

```bash
bash scripts/teardown.sh
```

Stops the proxy/LaunchAgent, disables the secure web proxy (or restores the previous setting if it was captured by `setup.sh`), removes the local CA trust from the login keychain, and leaves certificates plus the Soniox key for a fast re-setup. Add `--remove-key` / `--remove-certs` to delete those too.

## Reproduce

```bash
bash scripts/setup.sh --configure-app --smoke
bash scripts/health.sh
bash scripts/smoke-target.sh
bash scripts/smoke-passthrough.sh
node scripts/smoke-realtime.mjs
SMOKE_LONG=1 node scripts/smoke-realtime.mjs
pnpm test
```
