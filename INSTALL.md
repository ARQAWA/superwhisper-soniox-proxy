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
7. Build and start the proxy as a **LaunchAgent** (falls back to `nohup` if the agent cannot start).
8. Point the **Wi-Fi secure web proxy** at `127.0.0.1:8443`.
9. Create/activate the SuperWhisper **Soniox Target** and **Scribe Target** modes.
10. Apply the current `1.5 s` Soniox/Scribe endpoint profile and restart the app.

After it finishes, open SuperWhisper, select **Soniox Target**, and dictate.

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

The CA is local-only. Audio is sent only to Soniox; non-target traffic passes through to its real upstream.

## Verify

```bash
bash ~/.local/share/superwhisper-soniox-proxy/scripts/health.sh
bash ~/.local/share/superwhisper-soniox-proxy/scripts/smoke-target.sh
bash ~/.local/share/superwhisper-soniox-proxy/scripts/smoke-passthrough.sh
node ~/.local/share/superwhisper-soniox-proxy/scripts/smoke-realtime.mjs
```

The realtime smoke test prints only lengths and word counts, never the transcript.

## Upgrade an old install

Re-run the same one command:

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh | bash
```

The upgrade path is intentionally clean:

1. Stops the old proxy and the matching LaunchAgent.
2. Resets the installed checkout to `main`.
3. Removes the old `dist/` build so deleted files cannot survive.
4. Installs the locked dependencies from the current `pnpm-lock.yaml`.
5. Refreshes certificates, Keychain, proxy state, and LaunchAgent settings.
6. Updates both SuperWhisper modes and applies the current `1.5 s` profile.
7. Relaunches SuperWhisper.

It keeps your Soniox key, diagnostic traces, and SuperWhisper recordings, and keeps local certificates unless the CA is expiring. It does not touch unrelated LaunchAgents or apps.

For a manual checkout:

```bash
git pull --ff-only
rm -rf dist
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

Old installed checkouts need the current installer first, because the old script does not know `--upgrade`:

```bash
curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh -o /tmp/install.sh
bash /tmp/install.sh --upgrade
```

From a manual development checkout:

```bash
git pull --ff-only
rm -rf dist
pnpm install --frozen-lockfile
bash scripts/setup.sh --no-install --skip-proxy --launchd
bash scripts/start-fast.sh
```

Re-running the installer, or `install.sh --upgrade`, is the supported upgrade path. Do not run the old `scripts/setup.sh` alone: it does not remove the previous build or apply the current endpoint profile.

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
| LaunchAgent does not become healthy | Run `bash scripts/setup.sh` (nohup mode), then `bash scripts/start-fast.sh` to restore the profile; inspect `logs/proxy.stderr.log`. |
| Realtime falls back to batch | Check `logs/proxy.log` for `soniox realtime connected` / `CloseStream`; confirm the active mode is `soniox-target`. |
| Realtime hangs or cuts the end | Run `bash scripts/diagnostics.sh`; review `client_closed_before_final` and `close_to_finish_ms` in `~/Library/Caches/soniox-proxy/diagnostics/`. |
| Batch is slow | Soniox async processing p95 is around 4 s; realtime dictation avoids it. |
| CA expired | Run `bash scripts/setup.sh --no-install --skip-proxy --launchd`, then `bash scripts/start-fast.sh` (renews, re-trusts, and restores the profile). |

## Manual install from a clone

```bash
git clone https://github.com/ARQAWA/superwhisper-soniox-proxy.git
cd superwhisper-soniox-proxy
export SONIOX_API_KEY='...'
bash scripts/setup.sh --launchd --configure-app
bash scripts/start-fast.sh
```

Add `--smoke` to `setup.sh` to run the batch, pass-through, and realtime checks.

See `README.md` for architecture and configuration, `docs/recon.md` for the observed wire contracts, and `REPORT.md` for verification results.
