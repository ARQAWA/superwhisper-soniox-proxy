# Install and update

This proxy is local-only. It never reads or modifies SuperWhisper.

For the full agent procedure, read
[`AI_AGENT_READ_ME_FIRST_INSTALL_PROMPT.md`](AI_AGENT_READ_ME_FIRST_INSTALL_PROMPT.md).

## New Mac

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh | bash
```

The installer installs Homebrew dependencies, stores the Soniox key in Keychain,
creates or verifies the local CA, starts the LaunchAgent, enables the PAC, and
applies the quality profile. macOS may ask for the login password to trust the
local CA. Enter it only in the system dialog.

## Safe update

Run this on the other Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh -o /tmp/install.sh
bash /tmp/install.sh --upgrade --reset-context
```

The installer:

1. Refuses a dirty checkout, a different branch, or a non-fast-forward update.
2. Fast-forwards `main` and rebuilds `dist/`.
3. Reuses or renews certificates.
4. Restarts the proxy and applies the current profile.
5. Backs up and replaces the recognition prompt with the current profile.
6. Removes obsolete fallback settings from the proxy LaunchAgent.
7. Preserves the Soniox key, valid certificates, diagnostics, and SuperWhisper.

Use the command above for this update. Without `--reset-context`, an upgrade
keeps the existing recognition prompt. Do not add `--smoke`; dictation is
checked by the user.

Do not run as root. Do not reset a dirty checkout. Ask the user before using
`--clean`.

## Clean reinstall

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh -o /tmp/install.sh
bash /tmp/install.sh --clean
```

`--clean` removes the entire old checkout, including certificates and logs
stored inside it. It backs up the context prompt and writes the current
profile. The Keychain key is preserved. Do not use it for a normal update.
It never touches SuperWhisper.

## Verify

```bash
bash "$HOME/.local/share/superwhisper-soniox-proxy/scripts/health.sh"
```

The proxy must be healthy. Check these values:

1. `soniox_auto_language` is `hi`.
2. `soniox_endpoint_sensitivity` is `-1`.
3. `soniox_max_endpoint_delay_ms` is `3000`.
4. `scribe_verbatim` is `true`.
5. `scribe_vad_silence_threshold_secs` is `1`.

Run `scripts/smoke-realtime.mjs` only with the user's permission. It sends audio
to Soniox and prints only lengths.

## SuperWhisper

The installer never changes SuperWhisper. After install, select a mode yourself.

- Soniox Target: select Hindi for Soniox automatic language detection.
- Soniox Target: select Russian for a fixed Russian hint.
- Scribe Target: keeps verbatim text and does not use paid keyterms.

## If the update stops

If the installer reports a dirty checkout or divergent history, stop. Do not use
`git reset --hard`. Save the local changes or ask the user before `--clean`.

If the proxy is unhealthy, keep the logs and report them:
`$HOME/.local/share/superwhisper-soniox-proxy/logs/proxy.log`.
