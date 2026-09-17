#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
: "${DURE_HMUX_TEST_STATE_ROOT:?run through scripts/run-hmux-tests.mjs}"
case "$(uname -s)" in
  Darwin | Linux) ;;
  *) echo "managed create compatibility requires a native Unix target" >&2; exit 1 ;;
esac
target_triple=$(rustc -vV | sed -n 's/^host: //p')
if [ -z "$target_triple" ] || [ "${CARGO_BUILD_TARGET:-$target_triple}" != "$target_triple" ]; then
  echo "managed create compatibility requires the current native Rust target" >&2
  exit 1
fi

pnpm hmux:runtime:stage:dev
qa_home="$DURE_HMUX_TEST_STATE_ROOT/managed-create-home"
mkdir "$qa_home"
mkdir "$qa_home/.dure"
chmod 700 "$qa_home" "$qa_home/.dure"
qa_channel="qa-managed-create-$(basename "$DURE_HMUX_TEST_STATE_ROOT" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
hmux_cli="$repo_root/src-tauri/binaries/hmux-$target_triple"
runtime="$repo_root/src-tauri/binaries/hmux-runtime-$target_triple"
build_id=$(node scripts/hmux-dev-build-id.mjs)
# Immutable CLI code and package caches are build artifacts, not Hmux discovery
# state. Keep them in this worktree's artifact tree instead of making the
# bounded session scanner walk a complete SDK dependency installation.
cli_home="$repo_root/artifacts/qa/managed-create-compatibility-cli"
install_root="$cli_home/install"
mkdir -p "$cli_home" "$qa_home/.local/share/hebbian-ide-cli/channels"
chmod 700 "$cli_home"
run_isolated() {
  env HOME="$qa_home" \
    DURE_HOME="$qa_home/.dure" \
    HMUX_INSTALL_ROOT="$qa_home/hmux-install" \
    CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" \
    RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" \
    DURE_QA_APP_CHANNEL="$qa_channel" \
    DURE_HMUX_BIN="$hmux_cli" \
    DURE_HMUX_RUNTIME_BIN="$runtime" \
    DURE_HMUX_BUILD_ID="$build_id" \
    DURE_CLI_INSTALL_ROOT="$install_root" \
    DURE_CLI_INSTALL_DIR="$install_root/bin" \
    sh scripts/qa/lib/run-isolated-app.sh "$@"
}
run_isolated env HOME="$cli_home" DURE_HOME="$cli_home/.dure" \
  node scripts/install-dure-cli.mjs
ln -s "$install_root" "$qa_home/.local/share/hebbian-ide-cli/channels/$qa_channel"
run_isolated env HMUX_RUNTIME="$runtime" \
  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib \
    hmux::managed_create_compatibility_smoke:: \
    -- --ignored --nocapture --test-threads=1
