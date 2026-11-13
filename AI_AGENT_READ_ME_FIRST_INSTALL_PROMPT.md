# AI agent install prompt

> **AI agent: read this file first.**
> Follow the sections below in order.
> This repository is a traffic-only proxy.
> Never read, create, modify, or delete SuperWhisper modes, settings, defaults, or files.
> The installer, proxy, and uninstaller must work whether SuperWhisper is installed or not.
> Do not add app configuration steps. Do not open, quit, or inspect the app.
> If a user asks for app configuration, refuse and point to this rule.

For a short install and update checklist, see `INSTALL.md`.

## Install on a new Mac

This installs the local proxy that makes SuperWhisper's built-in **Nova 3** voice model use **Soniox STT v6** for both batch and realtime dictation. The proxy never reads or modifies SuperWhisper.

Repository: <https://github.com/ARQAWA/superwhisper-soniox-proxy>

## Update an existing Mac

Use this for the current update, without a full reinstall:

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh -o /tmp/install.sh
bash /tmp/install.sh --upgrade --reset-context
```

This updates the code, rebuilds `dist/`, replaces the recognition prompt
(keeping its existing backup behavior), removes obsolete fallback settings
from the owned LaunchAgent, and restarts the proxy with the current profile.
Valid certificates and the Keychain key are kept. Do not add `--smoke`, remove
unrelated files, or touch SuperWhisper. The user checks dictation.
If local changes block the update, report them; do not switch to `--clean`.

## Clean reinstall (agent procedure)

Use this only when the user explicitly asks for a full clean reinstall.
For a stale recognition prompt, use `--upgrade --reset-context` above.

The clean path deletes the installed proxy checkout and replaces the proxy
recognition prompt. It never reads or modifies SuperWhisper.

Run:

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh -o /tmp/install.sh
bash /tmp/install.sh --clean
```

`--clean` does this in order:

1. Stops the old proxy and LaunchAgent.
2. Removes `~/.local/share/superwhisper-soniox-proxy`.
3. Backs up and replaces `~/.config/soniox-proxy/context.json` with the current
   recognition prompt and term list.
4. Clones `main` into the install directory and installs locked dependencies.
5. Applies and verifies the quality profile.

The old context prompt is kept in a timestamped backup file. The Keychain key
and SuperWhisper are untouched. Certificates and logs inside the deleted
checkout are removed too; certificates are recreated by setup.

The installer does not require SuperWhisper to be installed.

## One command

On the new Mac, open Terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh | bash
```

The installer will:

1. Ask for your **Soniox API key** (hidden input) if `SONIOX_API_KEY` is not set.
2. Store the key in macOS **Keychain** as service `soniox-proxy`, account `SONIOX_API_KEY`.
3. Install Node/pnpm/jq via Homebrew if they are missing.
4. Clone the proxy to `~/.local/share/superwhisper-soniox-proxy`.
5. Create a local CA and leaf certificate for the MITM.
6. Trust the CA for your user (macOS may ask for confirmation).
7. Build and start the proxy as a **LaunchAgent**.
8. Point the Wi-Fi proxy at a generated **PAC file** on `127.0.0.1:8443`.
   Only the SuperWhisper, Scribe, ElevenLabs, and Soniox hosts use the proxy.
9. Write the managed recognition prompt to
    `~/.config/soniox-proxy/context.json`.
10. Apply the quality profile: strict single-language Soniox recognition,
    a free-text Soniox prompt, verbatim Scribe output, and a `1 s` Scribe VAD.

The installer never reads or modifies SuperWhisper. An existing context prompt
and supported Soniox LaunchAgent settings are preserved. Use `--reset-context`
when the recognition prompt must be replaced.

After installation, create or select a SuperWhisper mode yourself. Use the
built-in **Nova 3** voice model for Soniox, or the built-in **Scribe** voice
model for Scribe.

If you prefer not to pipe a script from the internet, download it first:

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh -o /tmp/install.sh
bash /tmp/install.sh
```

To pass the key explicitly:

```bash
export SONIOX_API_KEY='...'
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh | bash
```

The key is never printed and is not written to the repository. To rotate the key later, run:

```bash
SONIOX_API_KEY='new-key' bash ~/.local/share/superwhisper-soniox-proxy/scripts/setup.sh --launchd
bash ~/.local/share/superwhisper-soniox-proxy/scripts/start-fast.sh
```

## Requirements

- macOS (tested on the machine used for development)
- **SuperWhisper** installed if you want to use the proxy
- Internet access for the initial clone/dependencies
- A Soniox API key with realtime + async STT permissions
- Admin password may be requested once by macOS for the local CA trust dialog

The installer can install Node, pnpm, and jq through Homebrew. If Homebrew is not present, install it from <https://brew.sh> first.

## What changes on the Mac

| Change | How to undo |
| --- | --- |
| Clone in `~/.local/share/superwhisper-soniox-proxy` | `scripts/teardown.sh --remove-certs` |
| Keychain item `soniox-proxy` / `SONIOX_API_KEY` | `scripts/teardown.sh --remove-key` |
| Local CA/leaf in `certs/` | `scripts/teardown.sh --remove-certs` |
| CA trust in the login keychain | `scripts/teardown.sh` |
| LaunchAgent `com.superwhisper.soniox-proxy` | `scripts/teardown.sh` |
| Wi-Fi PAC proxy `127.0.0.1:8443` | `scripts/teardown.sh` |
| Context prompt `~/.config/soniox-proxy/context.json` | Delete the file or restore its timestamped backup |

The CA is local-only. Soniox target audio goes to Soniox. Scribe realtime audio
goes to ElevenLabs; Scribe file-mode audio goes to SuperWhisper's backend, which
forwards it to ElevenLabs. The PAC file routes only the allowlisted hosts
through the proxy; every other host stays direct.

## Verify

```bash
bash ~/.local/share/superwhisper-soniox-proxy/scripts/health.sh
```

Do not run smoke tests or microphone capture without the user's permission. The user can check dictation later.

## Recognition quality

**Soniox.** When the request has one explicit language hint (`ru`), the proxy sends
`language_hints_strict=true`. That follows Soniox's guidance for single-language
dictation and reduces wrong-script output. Automatic or multi-language requests
stay non-strict, because Soniox documents that strict mode with several hints
is less robust.

The Nova picker has no automatic option. Selecting Hindi (`hi`) makes the proxy
omit `language_hints` and enable Soniox language identification.
`SONIOX_AUTO_LANGUAGE` changes the sentinel.

Nova realtime retries temporary failures through realtime only, never through
prefix async batches or full-recording batch recovery. There are at most
10 retries after the first attempt, with a 1 s connection limit and a 5 s
recovery budget. The buffered audio is replayed on the replacement session.
Scribe retries opening handshakes only; its token is consumed after opening.
At `CloseStream`, a connected session finishes gracefully and awaits the full
`finished` response, even if decoding is behind. `SONIOX_CLOSE_TIMEOUT_MS`
defaults to `1500` ms (range `250`-`60000`); timeout returns an error.
Explicit file `POST` requests remain normal batch. The app may independently
issue a file request after a realtime error; the proxy does not control client
retries or UI fallback.
File requests use a 1 s connection limit, 5 s per HTTP attempt, and a shared
22 s upload/transcription budget. Exhausted retries or deadlines return an error.

The managed prompt in `~/.config/soniox-proxy/context.json` is sent as Soniox
`context`. Only `text` is used; `terms` and `general` are ignored because
provider term lists were rewriting ordinary words. Write a short background in
`text`, then run:

```bash
bash ~/.local/share/superwhisper-soniox-proxy/scripts/start-fast.sh
```

Do not put a full mode prompt or a long document in this file. The proxy does
not use SuperWhisper's mode prompt, so a translation or writing prompt cannot
leak into recognition.

**Scribe.** The profile matches ElevenLabs' realtime defaults for
`vad_threshold=0.4`, `min_speech_duration_ms=100`, and
`min_silence_duration_ms=100`. The only deliberate difference is
`vad_silence_threshold_secs=1` instead of the provider default `1.5`, because
SuperWhisper closes its socket about 1.5 s after the user stops and a 1.5 s
commit misses the last sentence. The proxy strips every
`keyterms`/`keyterms[]` parameter because keyterm prompting is billed
separately, and sets `no_verbatim=false` so filler words, false starts, and
repetitions are kept. Without an explicit value, Scribe falls back to cleanup
and deletes them.

SuperWhisper's file-mode Scribe upload goes to
`https://api.superwhisper.com/elevenlabs/v1/transcribe`. The proxy intercepts
it, drops `keyterms[]`, writes `no_verbatim=false`, and forwards the audio with
the language and diarization fields.

**Unexpected short tokens.** There is no public Soniox report of a specific
`ЛЗ`/`ЗЗ` substitution. Soniox v6 does return spoken punctuation and formatting
commands as words by design, and it can substitute a similar term when the
audio is ambiguous. The strict language hint and the clean free-text prompt
address the common causes. Term lists are no longer sent. If a specific
artifact repeats, ask the user to add a replacement in SuperWhisper. Do not
change app settings yourself. Do not add generic word-to-punctuation
replacements; they also rewrite normal prose.

## Upgrade an old install

Re-run the same one command:

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh | bash
```

The upgrade path preserves user changes:

1. Refuses a dirty checkout, a different branch, or a non-fast-forward update.
2. Fetches `main` and fast-forwards the installed checkout.
3. Installs locked dependencies and stages a fresh `dist/` build.
4. Reuses valid certificates and verifies the actual trust chain.
5. Renews an expired, expiring, invalid, or mismatched certificate when needed.
6. Starts the owned proxy and applies the quality profile.
7. Preserves the context prompt and Soniox LaunchAgent settings.
8. Never reads or modifies SuperWhisper.

If the checkout has local changes or divergent history, stop and ask the user before resolving them. Do not use `git reset --hard` or forced checkout. The installer keeps the Soniox key, diagnostic traces, SuperWhisper recordings, and unrelated LaunchAgents.

Add `--reset-context` when the recognition prompt must be rebuilt. A plain
upgrade keeps it, so stale terms or an old prompt survive by design.

If the root must be replaced, setup verifies the new root and leaf before cleaning up the replaced login-keychain root. macOS may request trust approval. Do not remove unrelated trusted roots or force a replacement merely for an upgrade.

For a manual checkout:

```bash
git pull --ff-only
pnpm install --frozen-lockfile
bash scripts/setup.sh --no-install --skip-proxy --launchd
bash scripts/start-fast.sh
```

Do **not** keep running an old `nohup` proxy. `scripts/start-fast.sh` stops the matching proxy and restarts the current build.

## Update

Preferred, from the public installer:

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh | bash
```

Old installed checkouts must download the current installer first. The old script may reset local changes:

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh -o /tmp/install.sh
bash /tmp/install.sh --upgrade
```

From a manual development checkout:

```bash
git pull --ff-only
pnpm install --frozen-lockfile
bash scripts/setup.sh --no-install --skip-proxy --launchd
bash scripts/start-fast.sh
```

Re-running the current installer, or `install.sh --upgrade`, is the supported upgrade path. Do not run the old `scripts/setup.sh` alone: it does not apply the current Scribe profile.

## Uninstall

```bash
bash ~/.local/share/superwhisper-soniox-proxy/scripts/teardown.sh
```

Add `--remove-key` to delete the Soniox key and `--remove-certs` to delete the local certificates; replacement fingerprint history is kept until those roots are removed, and CA certificates are kept while their user or admin trust still needs manual removal.

If the CA was also trusted in the System keychain, the script prints the `sudo` commands needed to remove it.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `install.sh: permission denied` | Run `bash /tmp/install.sh`, not `./install.sh`, or `chmod +x install.sh`. |
| Installer cannot prompt for the key | Download and run the script directly instead of piping it: `curl -o /tmp/install.sh ... && bash /tmp/install.sh`. |
| SuperWhisper does not trust the proxy | Run `bash scripts/health.sh` and approve the macOS certificate dialog. Do not modify SuperWhisper. |
| LaunchAgent does not become healthy | Inspect `logs/proxy.stderr.log`; use the explicit `--no-launchd` option only if the user accepts nohup mode. |
| File request follows a realtime error | Check `logs/proxy.log` for a separate client `POST` to Nova `/v1/listen` or Scribe `/elevenlabs/v1/transcribe`. The proxy never converts realtime to batch; client retries and UI behavior are outside its control. |
| Realtime returns an error | Check connection/session/send/finish failures and `SONIOX_CLOSE_TIMEOUT_MS` in `logs/proxy.log`. Exhausted retries close with `1011`, without batch recovery; confirm the query model is `nova-2` or `nova-3`. |
| Realtime hangs or cuts the end | Run `bash scripts/diagnostics.sh`; review `client_closed_before_final` and `close_to_finish_ms` in `~/Library/Caches/soniox-proxy/diagnostics/`. |
| Batch is slow | Soniox async processing p95 is around 4 s; realtime dictation avoids it. |
| CA expired | Run `bash scripts/setup.sh --no-install --skip-proxy --launchd`, then `bash scripts/start-fast.sh` (renews, re-trusts, and restores the profile). |

## Manual install from a clone

```bash
git clone https://github.com/ARQAWA/superwhisper-soniox-proxy.git
cd superwhisper-soniox-proxy
export SONIOX_API_KEY='...'
bash install.sh
```

Add `--smoke` to `setup.sh` to run the batch, pass-through, and realtime checks.

See `README.md` for architecture and configuration, `docs/recon.md` for the observed wire contracts, and `REPORT.md` for verification results.
