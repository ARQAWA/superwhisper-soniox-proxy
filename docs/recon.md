# Reconnaissance notes

Date: 2026-11-07

> The shipped setup now uses a PAC allowlist instead of a global proxy. This page records the original reconnaissance, which used the secure web proxy to observe traffic.

Target: SuperWhisper 3.2.1 (`/Applications/SuperWhisper.app`)
Goal: replace the built-in Nova 3 cloud transcription with Soniox STT v6 without patching the app.

## Method

1. Enabled the macOS **Wi-Fi secure web proxy** at `127.0.0.1:8443`.
2. Generated a local CA and a leaf certificate for `api.deepgram.com`, `api.superwhisper.com`, `localhost`, `127.0.0.1`, and `::1` (`scripts/gen-certs.sh`).
3. Trusted the CA for the current user and restarted SuperWhisper.
4. Ran the proxy in `DRY_RUN=true CAPTURE_TEMPLATE=true` mode. In this mode target requests are passed to the real upstream, but request metadata and a schema-only template are recorded.
5. Compared the captured traffic with the app's local modes/settings and with Soniox's documented API.
6. Switched to `DRY_RUN=false` only after the contracts were known.

No app binary was patched. The signature was re-checked after every app restart.

## Observed host and endpoints

The app does **not** send dictation audio to `api.superwhisper.com`. The batch request goes to:

```
POST https://api.deepgram.com/v1/listen
Content-Type: audio/ogg
Body: raw Ogg/Opus bytes (not multipart)
```

Observed batch query parameters (values are protocol constants, except `<language>`/`<model>`):

```
?punctuate=true
&paragraphs=true
&numerals=true
&smart_format=true
&language=<language>
&model=nova-3
```

The app may add `keyterm=...` entries from its context settings. Those values are user data and are redacted in logs by `src/url-utils.ts`.

`api.superwhisper.com` is used for model lists, licensing, and other non-dictation traffic. It is passed through untouched.

## Batch response contract

The captured response is a Deepgram-shaped JSON document:

```
{
  "metadata": {
    "transaction_key": "",
    "request_id": "",
    "sha256": "",
    "created": "",
    "duration": 0,
    "channels": 0,
    "models": [""],
    "model_info": { "<uuid>": { "name": "", "version": "", "arch": "" } }
  },
  "results": {
    "channels": [{
      "alternatives": [{
        "transcript": "",
        "confidence": 0,
        "words": [{
          "word": "", "start": 0, "end": 0,
          "confidence": 0, "punctuated_word": ""
        }],
        "paragraphs": {
          "transcript": "",
          "paragraphs": [{
            "sentences": [{ "text": "", "start": 0, "end": 0 }],
            "num_words": 0, "start": 0, "end": 0
          }]
        }
      }]
    }]
  }
}
```

The sanitized template is stored in `fixtures/superwhisper-response.template.json`. The template contains no transcript text, audio, or request identifiers. `src/template.ts` fills it from Soniox tokens; `src/tokens.ts` merges Soniox subword pieces into whole words first.

Recon evidence: `fixtures/recon-capture.json` contains the redacted request summary and the response schema (`describeSchema`). It intentionally contains no audio, transcript, key, or cookie.

## Realtime WebSocket contract

SuperWhisper opens:

```
wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1
  &diarize=false&smart_format=true&interim_results=true
  &model=nova-2&language=<language>&keywords=...
```

Important detail: **the realtime request says `model=nova-2` even when the selected mode uses Nova 3.** The app's mode JSON is the source of truth:

```
~/Documents/superwhisper/modes/<activeModeKey>.json
  .voiceModelID == "sw-deepgram-nova-3"
  .realtimeOutput == true
```

The proxy reads the active mode key via:

```
defaults read com.superduper.superwhisper activeModeKey
```

and then reads the matching mode JSON. `isTargetRealtimeRequest()` in `src/realtime.ts` treats a realtime socket as target traffic when the query model is in `TARGET_REALTIME_QUERY_MODELS` (`nova-2,nova-3`) and the active mode uses `sw-deepgram-nova-3`. A query model literally equal to `TARGET_MODEL` (`nova-3`) is accepted directly (used by the smoke test).

Client frames observed:

- Binary frames of raw `linear16` PCM, 16 kHz, mono. The app sent 342-byte chunks (about 10.7 ms of audio).
- `{"type":"CloseStream"}` text frame at the end. No `Finalize` or `KeepAlive` frames were observed in the captured sessions.

Server messages captured from real Deepgram pass-through (`fixtures/wss-server-schema.json`, schema-only):

- `Results` with `type`, `channel_index`, `duration`, `start`, `is_final`, `speech_final`, `channel`, `metadata`, `from_finalize`.
- An initial empty `Results` with `is_final=true`.
- Growing interim results, then final result(s), then a `Metadata` message at stream end.

The bridge reproduces this shape; the app does not need to know Soniox is behind it.

## Soniox behavior that mattered

Two Soniox realtime behaviors caused the original realtime fragmentation/truncation:

1. **Subword tokens.** Soniox returns pieces such as `"про"`, `"вер"`, `"ка"` with a leading space marking the start of a word. Sending those pieces directly as Deepgram words/transcript produced `"ди кту ю"`. `mergeTokensToWords()` joins them and attaches punctuation to the previous word.
2. **Sliding token window.** Soniox occasionally finalizes a prefix and then stops returning it. A later `result.tokens` array contains only the newer part. Replacing the transcript with each result therefore dropped everything before the last pause. The bridge accumulates finalized tokens (`finalTokens`) and appends the current tail rather than replacing history.

Endpoint detection was disabled for the app bridge. With it enabled, Soniox emitted many endpoint events and the app received many tiny final segments. One growing interim stream plus one final segment at `CloseStream` produced stable text:

- short fixture: 85 characters, 11 words, no duplicates;
- fixture repeated with a 2 s silence: 171 characters, 22 words, `final_length >= max_interim_length`;
- the same fixture with an 8 s silence also produced 171 characters / 22 words with 0 interim drops.

Soniox needs about 250 ms after `CloseStream` to decode the very end of the audio. The bridge therefore sends the final result as soon as Soniox reports `finished`, then waits `WS_CLOSE_DELAY_MS` (350 ms) before closing the app socket so the UI can render the last words.

## Target detection summary

| Traffic | Detection |
| --- | --- |
| Batch `POST /v1/listen`, `model=nova-3`, audio file | `TARGET_HOST` + `TARGET_PATH` + `TARGET_MODEL` |
| Realtime `/v1/listen` upgrade, `model=nova-2` or `nova-3` | query model in `TARGET_REALTIME_QUERY_MODELS` **and** active mode `voiceModelID === sw-deepgram-nova-3` |
| Everything else | Pass-through |

All other hosts use a raw CONNECT tunnel and are never decrypted. `api.deepgram.com` uses a local-CA MITM because it is the target host; non-target paths/models on that host are forwarded to the real Deepgram over TLS and logged as pass-through.

## Reproduction

```bash
# 1. trust the local CA (one time)
bash scripts/gen-certs.sh
security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db certs/ca.crt

# 2. run in capture mode
DRY_RUN=true CAPTURE_TEMPLATE=true LOG_LEVEL=debug node dist/src/index.js

# 3. point the system proxy at 127.0.0.1:8443, restart SuperWhisper, use Nova 3

# 4. inspect schema-only evidence
jq '.' fixtures/recon-capture.json
jq '.' fixtures/superwhisper-response.template.json
jq '.' fixtures/wss-server-schema.json
```

## Privacy notes

- Recon records contain no audio bytes, no transcript strings, no `Authorization`/cookie headers, and no API keys.
- The response template is zeroed (`sanitizeForTemplate`) before it is written.
- `fixtures/wss-server-schema.json` stores message types, flags, lengths, and word counts, not text.
- Logs redact `keyterm`, `keywords`, `prompt`, `context`, tokens, and unknown query parameters via `redactQuery()`.

## Limitations

- The contract is tied to SuperWhisper 3.2.1. A future update may change the host, query, or message format; re-run this recon in that case.
- The app's realtime query uses `nova-2` while the selected voice model is Nova 3. This is an app implementation detail, not a Deepgram requirement.
- The captured realtime schema came from a temporary Nova 2 pass-through session. It is used only as a shape reference; no target audio was sent to Deepgram during Soniox operation.
