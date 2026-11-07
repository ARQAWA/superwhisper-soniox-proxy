#!/bin/bash
# Public installer for the SuperWhisper -> Soniox local proxy.
#
# One-liner (from a public GitHub repo):
#   curl -fsSL https://raw.githubusercontent.com/ARQAWA/superwhisper-soniox-proxy/main/install.sh | bash
#
# If the Soniox key is not in the environment, the installer prompts for it from
# the terminal. The key is stored in Keychain and never printed.
set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-ARQAWA/superwhisper-soniox-proxy}"
REPO_URL="${REPO_URL:-https://github.com/${GITHUB_REPO}.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/superwhisper-soniox-proxy}"

USE_LAUNCHD=1
RUN_SMOKE=0
CONFIGURE_APP=1

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --no-launchd        Use nohup instead of a LaunchAgent (not persistent across reboots).
  --smoke             Run batch, pass-through, and realtime smoke tests after setup.
  --no-configure-app  Do not create/activate the SuperWhisper "Soniox Target" mode.
  -h, --help          Show this help.

Environment:
  SONIOX_API_KEY      Soniox API key. If unset, setup prompts with hidden input.
  INSTALL_DIR         Checkout directory (default: ~/.local/share/superwhisper-soniox-proxy).
  GITHUB_REPO         GitHub repo in owner/name form.
  REPO_URL            Full git URL override.
  BRANCH              Branch to install (default: main).
EOF
}

for arg in "$@"; do
  case "$arg" in
    --no-launchd) USE_LAUNCHD=0 ;;
    --smoke) RUN_SMOKE=1 ;;
    --no-configure-app) CONFIGURE_APP=0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $arg (try --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] && die "run this as your normal macOS user, not with sudo/root"

# If this script is part of a local checkout, install from that checkout.
ROOT=""
script_source="${BASH_SOURCE[0]:-}"
if [ -n "$script_source" ] && [ -f "$script_source" ]; then
  candidate="$(cd "$(dirname "$script_source")" && pwd)"
  if [ -f "$candidate/package.json" ] && [ -d "$candidate/src" ]; then
    ROOT="$candidate"
  fi
fi

if [ -z "$ROOT" ]; then
  command -v git >/dev/null 2>&1 || die "git is required. Install Xcode Command Line Tools or run: xcode-select --install"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ -d "$INSTALL_DIR/.git" ]; then
    say "updating $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" checkout -q "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard -q "origin/$BRANCH"
  else
    say "cloning $REPO_URL"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
  ROOT="$INSTALL_DIR"
fi
cd "$ROOT"

ensure_homebrew_package() {
  local command_name="$1"
  local formula="$2"
  command -v "$command_name" >/dev/null 2>&1 && return 0
  if command -v brew >/dev/null 2>&1; then
    say "installing $formula with Homebrew..."
    brew install "$formula"
  else
    die "$command_name is missing. Install Homebrew (https://brew.sh) or $formula manually."
  fi
}

ensure_homebrew_package node node
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 22 ]; then
  if command -v brew >/dev/null 2>&1; then
    say "upgrading Node with Homebrew..."
    brew upgrade node
    node_major="$(node -p 'process.versions.node.split(".")[0]')"
  fi
fi
[ "$node_major" -ge 22 ] || die "Node >= 22 is required (found $(node -v)). Update with: brew upgrade node"

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@10.12.1 --activate >/dev/null 2>&1 || true
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    command -v npm >/dev/null 2>&1 || die "pnpm/npm is missing"
    npm install -g pnpm@10.12.1 || die "could not install pnpm; run: sudo npm install -g pnpm@10.12.1"
  fi
fi

ensure_homebrew_package jq jq
command -v openssl >/dev/null 2>&1 || die "openssl is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v security >/dev/null 2>&1 || die "macOS security tool is required"
command -v networksetup >/dev/null 2>&1 || die "macOS networksetup tool is required"

# When the installer itself is piped from curl, stdin is the script. Reopen the
# terminal so setup can prompt for the Soniox key and macOS can show auth dialogs.
if [ ! -t 0 ] && [ -r /dev/tty ]; then
  exec </dev/tty
fi

if [ "$CONFIGURE_APP" = "1" ] && [ ! -d /Applications/SuperWhisper.app ]; then
  say "SuperWhisper.app is not installed yet."
  say "Install it, open it once, then re-run this installer (or run: bash scripts/configure-superwhisper-mode.sh)."
  say "The proxy is installed anyway; the SuperWhisper mode step is skipped."
  CONFIGURE_APP=0
fi

setup_args=()
[ "$USE_LAUNCHD" = "1" ] && setup_args+=(--launchd)
[ "$CONFIGURE_APP" = "1" ] && setup_args+=(--configure-app)
[ "$RUN_SMOKE" = "1" ] && setup_args+=(--smoke)

say "installing from $ROOT"
if ! bash scripts/setup.sh "${setup_args[@]}"; then
  if [ "$USE_LAUNCHD" = "1" ]; then
    say "LaunchAgent setup failed; falling back to nohup mode."
    fallback_args=()
    [ "$CONFIGURE_APP" = "1" ] && fallback_args+=(--configure-app)
    [ "$RUN_SMOKE" = "1" ] && fallback_args+=(--smoke)
    bash scripts/setup.sh "${fallback_args[@]}"
  else
    exit 1
  fi
fi

say ""
say "installed at: $ROOT"
say "health:       bash \"$ROOT/scripts/health.sh\""
say "logs:         \"$ROOT/logs/proxy.log\""
say "uninstall:    bash \"$ROOT/scripts/teardown.sh\""
say "update:       re-run this installer, or: git -C \"$ROOT\" pull && bash \"$ROOT/scripts/setup.sh\""
say ""
say "Open SuperWhisper and select the \"Soniox Target\" mode, then dictate."
