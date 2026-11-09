# Install on a new Mac

This installs the local proxy that makes SuperWhisper's built-in **Nova 3** voice model use **Soniox STT v6** for both batch and realtime dictation. The app itself is not modified.

Repository: <https://github.com/ARQAWA/superwhisper-soniox-proxy>

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
8. Point the **Wi-Fi secure web proxy** at `127.0.0.1:8443`.
9. Create missing **Soniox Target** and **Scribe Target** modes.
10. Apply the `0.5 s` Scribe VAD profile.

Existing modes, their selected languages and audio sources, the active selection, and existing Soniox LaunchAgent settings are preserved. After installation, select the target mode you want in SuperWhisper.

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
- **SuperWhisper** installed in `/Applications` and opened at least once
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
| Wi-Fi secure web proxy `127.0.0.1:8443` | `scripts/teardown.sh` |
| SuperWhisper mode `soniox-target` and active mode key | Remove the mode in SuperWhisper / use another mode |

The CA is local-only. Soniox target audio goes to Soniox, and Scribe target audio goes to ElevenLabs. Non-target traffic passes through to its real upstream.

## Verify

```bash
bash ~/.local/share/superwhisper-soniox-proxy/scripts/health.sh
```

Do not run smoke tests or microphone capture without the user's permission. The user can check dictation later.

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
6. Starts the owned proxy and applies the `0.5 s` Scribe profile.
7. Preserves existing modes, the active mode, and Soniox LaunchAgent settings.

If the checkout has local changes or divergent history, stop and ask the user before resolving them. Do not use `git reset --hard` or forced checkout. The installer keeps the Soniox key, diagnostic traces, SuperWhisper recordings, and unrelated LaunchAgents.

SuperWhisper may store its configuration under `~/superwhisper`, the older `~/Documents/superwhisper`, or a user-selected parent folder. The proxy and installer read the configured location. Set `SUPERWHISPER_DOCS_DIR` only when an explicit override is needed.

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
| SuperWhisper does not trust the proxy | Run `bash scripts/health.sh`, approve the macOS certificate dialog, then quit/reopen SuperWhisper. |
| LaunchAgent does not become healthy | Inspect `logs/proxy.stderr.log`; use the explicit `--no-launchd` option only if the user accepts nohup mode. |
| Realtime falls back to batch | Check `logs/proxy.log` for `soniox realtime connected` / `CloseStream`; confirm the active mode is `soniox-target`. |
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
