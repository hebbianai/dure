#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
case "$(uname -s)" in
  Darwin | Linux) ;;
  *) echo "create runtime compatibility requires a native Unix target" >&2; exit 1 ;;
esac
target_triple=$(rustc -vV | sed -n 's/^host: //p')
if [ -z "$target_triple" ] || [ "${CARGO_BUILD_TARGET:-$target_triple}" != "$target_triple" ]; then
  echo "create runtime compatibility requires the current native Rust target" >&2
  exit 1
fi

runtime="$repo_root/src-tauri/binaries/hmux-runtime-$target_triple"
cli="$repo_root/src-tauri/binaries/hmux-$target_triple"
if [ -z "${DURE_HMUX_TEST_STATE_ROOT:-}" ]; then
  pnpm hmux:runtime:stage:dev
  exec env DURE_QA_HMUX_BIN="$cli" DURE_QA_HMUX_RUNTIME="$runtime" \
    node scripts/run-hmux-tests.mjs -- sh "$0"
fi
qa_home="$DURE_HMUX_TEST_STATE_ROOT/create-compatibility-home"
mkdir -m 700 "$qa_home"
mkdir -m 700 "$qa_home/.dure"
env HOME="$qa_home" DURE_HOME="$qa_home/.dure" \
  CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" \
  RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" \
  HMUX_INSTALL_ROOT="$qa_home/hmux-install" \
  SHELL=/bin/sh \
  DURE_QA_APP_CHANNEL="qa-create-compatibility" \
  sh scripts/qa/lib/run-isolated-app.sh env HMUX_RUNTIME="$runtime" \
  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib \
    hmux::runtime:: \
    -- --include-ignored --nocapture --test-threads=1
