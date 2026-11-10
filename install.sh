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
REMOTE_INSTALL=0
FORCE_UPGRADE=0
CLEAN=0

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --no-launchd        Use nohup instead of a LaunchAgent (not persistent across reboots).
  --smoke             Run batch, pass-through, and realtime smoke tests after setup.
  --upgrade           Force an update of the installed checkout even when run from it.
  --clean             Clean reinstall: remove the old checkout, reset the proxy
                      recognition context, then install fresh.
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
    --upgrade) FORCE_UPGRADE=1 ;;
    --clean) CLEAN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $arg (try --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] && die "run this as your normal macOS user, not with sudo/root"

# If this script is the installed checkout's own installer, treat a plain
# re-run as an upgrade. Do this before the self-update re-exec so an update cannot
# change the running script.
script_source="${BASH_SOURCE[0]:-}"

# --clean removes the checkout that may contain this script. Re-exec from the
# open file descriptor first so bash never needs the deleted path again.
if [ "$CLEAN" = "1" ] && [ "${CLEAN_REEXEC:-0}" != "1" ] && [ -n "$script_source" ] && [ -f "$script_source" ]; then
  source_dir="$(cd "$(dirname "$script_source")" && pwd)"
  install_dir="$(cd "$INSTALL_DIR" 2>/dev/null && pwd || true)"
  if [ -n "$install_dir" ] && [ "$source_dir" = "$install_dir" ]; then
    CLEAN_REEXEC=1 exec bash -s -- "$@" <"$script_source"
  fi
fi

auto_upgrade=0
if [ "$CLEAN" != "1" ] && [ -n "$script_source" ] && [ -f "$script_source" ]; then
  source_dir="$(cd "$(dirname "$script_source")" && pwd)"
  install_dir="$(cd "$INSTALL_DIR" 2>/dev/null && pwd || true)"
  if [ -n "$install_dir" ] && [ "$source_dir" = "$install_dir" ]; then
    auto_upgrade=1
  fi
fi
if [ "$auto_upgrade" = "1" ] && [ "$FORCE_UPGRADE" != "1" ]; then
  set -- "$@" --upgrade
  FORCE_UPGRADE=1
fi

# --upgrade may update the checkout that contains this script. Re-exec from the
# already-open file descriptor so the update cannot change the running script.
if [ "$FORCE_UPGRADE" = "1" ] && [ -n "$script_source" ] && [ -f "$script_source" ]; then
  exec bash -s -- "$@" <"$script_source"
fi

# If this script is part of a local checkout, install from that checkout.
ROOT=""
if [ "$CLEAN" != "1" ] && [ "$FORCE_UPGRADE" != "1" ] && [ -n "$script_source" ] && [ -f "$script_source" ]; then
  candidate="$(cd "$(dirname "$script_source")" && pwd)"
  if [ -f "$candidate/package.json" ] && [ -d "$candidate/src" ]; then
    ROOT="$candidate"
  fi
fi

clean_old_install() {
  local dir="$INSTALL_DIR" origin
  [ -d "$dir" ] || return 0
  case "$dir" in
    "$HOME/.local/share/"*) ;;
    *)
      die "refusing --clean outside ~/.local/share: $dir"
      ;;
  esac
  [ "$dir" != "$HOME/.local/share" ] || die "refusing --clean on the shared data directory"
  if [ -d "$dir/.git" ]; then
    origin="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
    case "$origin" in
      *"$GITHUB_REPO"*) ;;
      *)
        die "refusing --clean: $dir origin is ${origin:-unknown}, expected $GITHUB_REPO"
        ;;
    esac
  fi
  if [ -x "$dir/scripts/stop.sh" ]; then
    say "stopping the old proxy"
    if ! (cd "$dir" && bash scripts/stop.sh); then
      die "could not stop the old proxy in $dir; stop it manually before --clean"
    fi
  fi
  say "removing old install: $dir"
  rm -rf "$dir"
}

if [ -z "$ROOT" ]; then
  command -v git >/dev/null 2>&1 || die "git is required. Install Xcode Command Line Tools or run: xcode-select --install"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ "$CLEAN" = "1" ]; then
    clean_old_install
  fi
  if [ -d "$INSTALL_DIR/.git" ]; then
    say "updating $INSTALL_DIR"
    if [ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]; then
      die "local changes in $INSTALL_DIR; save them before upgrading"
    fi
    current_branch="$(git -C "$INSTALL_DIR" symbolic-ref --quiet --short HEAD || true)"
    [ "$current_branch" = "$BRANCH" ] \
      || die "expected branch $BRANCH in $INSTALL_DIR, found ${current_branch:-detached HEAD}"
    git -C "$INSTALL_DIR" fetch origin "$BRANCH"
    git -C "$INSTALL_DIR" merge --ff-only FETCH_HEAD \
      || die "cannot fast-forward $INSTALL_DIR; resolve its git history before upgrading"
  else
    say "cloning $REPO_URL"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
  ROOT="$INSTALL_DIR"
  REMOTE_INSTALL=1
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

if [ "$REMOTE_INSTALL" = "1" ]; then
  say "installing locked dependencies"
  (cd "$ROOT" && pnpm install --frozen-lockfile)
fi

# When the installer is piped from curl, stdin is the script. Prompt on the
# terminal explicitly and export the key; never replace the script input.
if [ -z "${SONIOX_API_KEY:-}" ] && [ ! -t 0 ]; then
  if ! security find-generic-password -s soniox-proxy -a SONIOX_API_KEY >/dev/null 2>&1; then
    if [ ! -r /dev/tty ]; then
      die "SONIOX_API_KEY is not set and no terminal is available"
    fi
    printf 'Soniox API key (input hidden): ' >/dev/tty
    if ! IFS= read -rsp '' key </dev/tty; then
      die "could not read the Soniox API key"
    fi
    printf '\n' >/dev/tty
    if [ -z "$key" ]; then
      die "empty Soniox API key"
    fi
    export SONIOX_API_KEY="$key"
    unset key
  fi
fi

if [ "$CLEAN" = "1" ]; then
  say "resetting the recognition context prompt"
  bash scripts/configure-soniox-context.sh --reset
else
  bash scripts/configure-soniox-context.sh
fi

setup_args=()
[ "$USE_LAUNCHD" = "1" ] && setup_args+=(--launchd)
[ "$RUN_SMOKE" = "1" ] && setup_args+=(--smoke)

say "installing from $ROOT"
bash scripts/setup.sh "${setup_args[@]}"

say "applying the current Scribe profile"
if ! (cd "$ROOT" && bash scripts/start-fast.sh); then
  die "proxy setup succeeded, but the current profile failed to apply. Run: bash $ROOT/scripts/start-fast.sh"
fi

say ""
say "installed at: $ROOT"
say "health:       bash \"$ROOT/scripts/health.sh\""
say "logs:         \"$ROOT/logs/proxy.log\""
say "uninstall:    bash \"$ROOT/scripts/teardown.sh\""
say "update:       re-run this installer (requires a clean checkout)"
say ""
say "The proxy does not read or modify SuperWhisper."
say "Create or select a SuperWhisper mode yourself."
