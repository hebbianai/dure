#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: run-first-run-onboarding-app.sh <isolated-root> <port>" >&2
  exit 64
fi

qa_root=$(cd "$1" 2>/dev/null && pwd -P) || {
  echo "isolated root does not exist: $1" >&2
  exit 64
}
qa_system_tmp=$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P) || exit 64
case "$qa_root" in
  /tmp/dure-onboarding-*|/private/tmp/dure-onboarding-*|"$qa_system_tmp"/dure-onboarding-*) ;;
  *)
    echo "refusing non-onboarding temporary root: $qa_root" >&2
    exit 64
    ;;
esac

qa_port=$2
case "$qa_port" in
  ''|*[!0-9]*)
    echo "port must be numeric" >&2
    exit 64
    ;;
esac
if [ "$qa_port" -lt 1024 ] || [ "$qa_port" -gt 65535 ]; then
  echo "port must be between 1024 and 65535" >&2
  exit 64
fi

if [ "$(uname -s)" = "Darwin" ]; then
  qa_macos_major=$(sw_vers -productVersion | cut -d. -f1)
  case "$qa_macos_major" in
    ''|*[!0-9]*)
      echo "could not determine the macOS version for WebView isolation" >&2
      exit 64
      ;;
  esac
  if [ "$qa_macos_major" -lt 14 ]; then
    echo "first-run WebView isolation requires macOS 14 or newer" >&2
    exit 64
  fi
fi

qa_node_dir=$(dirname "$(command -v corepack)")
qa_cargo_bin=$(dirname "$(command -v cargo)")
qa_path="$qa_node_dir:$qa_cargo_bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
qa_cargo_home=${CARGO_HOME:-}
if [ -z "$qa_cargo_home" ]; then
  qa_cargo_home=$(cd "$qa_cargo_bin/.." 2>/dev/null && pwd -P) || exit 64
fi
qa_rustup_home=${RUSTUP_HOME:-}
if [ -z "$qa_rustup_home" ]; then
  qa_rustup_home=$("$qa_cargo_bin/rustup" show home) || exit 64
fi
qa_repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P) || exit 64
qa_target_triple=$("$qa_cargo_bin/rustc" -vV | sed -n 's/^host: //p')
if [ -z "$qa_target_triple" ]; then
  echo "could not determine the Rust target triple for Hmux isolation" >&2
  exit 64
fi
qa_tmpdir=${TMPDIR:-/tmp}
qa_shell=${SHELL:-/bin/zsh}
qa_user=${USER:-$(id -un)}
qa_lang=${LANG:-en_US.UTF-8}
if command -v shasum >/dev/null 2>&1; then
  qa_instance=$(printf '%s' "$qa_root" | shasum -a 256 | cut -c1-20)
elif command -v sha256sum >/dev/null 2>&1; then
  qa_instance=$(printf '%s' "$qa_root" | sha256sum | cut -c1-20)
else
  echo "could not hash the isolated root for WebView isolation" >&2
  exit 64
fi
if [ -z "$qa_instance" ]; then
  echo "could not derive isolated dev instance from $qa_root" >&2
  exit 64
fi

umask 077
mkdir -p "$qa_root/home" "$qa_root/dure-home" "$qa_root/hmux-discovery"
chmod 700 "$qa_root/home" "$qa_root/dure-home" "$qa_root/hmux-discovery"

# HEBBIAN_DEV_INSTANCE is also the WebView data-store fence. Reusing this exact
# root intentionally preserves the onboarding journal across an app restart;
# a fresh temporary root gets a distinct persistent WKWebsiteDataStore even if
# the caller reuses the same Vite port.

# First-download simulation is an allowlist environment. In particular, do not
# inherit account overlays (CODEX_HOME/CLAUDE_CONFIG_DIR), credentials, SSH
# agents, Dure state, Hmux identity, or repository-local Git pointers.
exec env -i \
  HOME="$qa_root/home" \
  USER="$qa_user" \
  LOGNAME="$qa_user" \
  SHELL="$qa_shell" \
  LANG="$qa_lang" \
  TERM="xterm-256color" \
  TMPDIR="$qa_tmpdir" \
  PATH="$qa_path" \
  CARGO_HOME="$qa_cargo_home" \
  RUSTUP_HOME="$qa_rustup_home" \
  DURE_HOME="$qa_root/dure-home" \
  HEBBIAN_HOME="$qa_root/dure-home" \
  XDG_CONFIG_HOME="$qa_root/xdg-config" \
  XDG_DATA_HOME="$qa_root/xdg-data" \
  XDG_STATE_HOME="$qa_root/xdg-state" \
  XDG_CACHE_HOME="$qa_root/xdg-cache" \
  DURE_BUILD_STORAGE_RESERVATION_V1="${DURE_BUILD_STORAGE_RESERVATION_V1:-}" \
  DURE_HMUX_BIN="$qa_repository_root/src-tauri/binaries/hmux-$qa_target_triple" \
  DURE_HMUX_RUNTIME_BIN="$qa_repository_root/src-tauri/binaries/hmux-runtime-$qa_target_triple" \
  HMUX_DISCOVERY_ROOT="$qa_root/hmux-discovery" \
  DURE_DEV_PORT="$qa_port" \
  HEBBIAN_DEV_INSTANCE="$qa_instance" \
  CLAUDE_CONFIG_DIR="$qa_root/home/.claude" \
  CODEX_HOME="$qa_root/home/.codex" \
  GEMINI_CLI_HOME="$qa_root/home/.gemini" \
  PI_CODING_AGENT_SESSION_DIR="$qa_root/home/.pi/agent/sessions" \
  GROK_HOME="$qa_root/home/.grok" \
  sh -c 'corepack pnpm hmux:runtime:stage:dev >&2 && exec corepack pnpm app:dev'
