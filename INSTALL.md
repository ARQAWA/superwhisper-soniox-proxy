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
9. Create/activate the SuperWhisper **Soniox Target** mode.

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
SONIOX_API_KEY='new-key' bash ~/.local/share/superwhisper-soniox-proxy/scripts/setup.sh
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

## Update

```bash
bash ~/.local/share/superwhisper-soniox-proxy/install.sh
```

or:

```bash
git -C ~/.local/share/superwhisper-soniox-proxy pull
bash ~/.local/share/superwhisper-soniox-proxy/scripts/setup.sh
```

## Uninstall

```bash
bash ~/.local/share/superwhisper-soniox-proxy/scripts/teardown.sh
```

Add `--remove-key` to delete the Soniox key and `--remove-certs` to delete the local certificates.

If the CA was also trusted in the System keychain, the script prints the one `sudo` command needed to remove it.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `install.sh: permission denied` | Run `bash /tmp/install.sh`, not `./install.sh`, or `chmod +x install.sh`. |
| Installer cannot prompt for the key | Download and run the script directly instead of piping it: `curl -o /tmp/install.sh ... && bash /tmp/install.sh`. |
| SuperWhisper does not trust the proxy | Run `bash scripts/health.sh`, approve the macOS certificate dialog, then quit/reopen SuperWhisper. |
| LaunchAgent does not become healthy | Run `bash scripts/setup.sh` (nohup mode) or inspect `logs/proxy.stderr.log`. |
| Realtime falls back to batch | Check `logs/proxy.log` for `soniox realtime connected` / `CloseStream`; confirm the active mode is `soniox-target`. |
| Batch is slow | Soniox async processing p95 is around 4 s; realtime dictation avoids it. |
| CA expired | Run `bash scripts/gen-certs.sh`, re-trust, restart SuperWhisper. |

## Manual install from a clone

```bash
git clone https://github.com/ARQAWA/superwhisper-soniox-proxy.git
cd superwhisper-soniox-proxy
export SONIOX_API_KEY='...'
bash scripts/setup.sh --configure-app --smoke
```

See `README.md` for architecture and configuration, `docs/recon.md` for the observed wire contracts, and `REPORT.md` for verification results.
