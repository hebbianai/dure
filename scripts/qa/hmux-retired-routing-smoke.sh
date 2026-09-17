#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
: "${DURE_HMUX_TEST_STATE_ROOT:?run through scripts/run-hmux-tests.mjs}"

cargo build --manifest-path hmux/Cargo.toml --package hmux-runtime --package hmux-cli

qa_home="$DURE_HMUX_TEST_STATE_ROOT/retired-routing-home"
mkdir "$qa_home"
env HOME="$qa_home" \
  CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" \
  RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" \
  cargo test --manifest-path hmux/Cargo.toml --package hmux-cli \
    --test managed_rehost_routing -- --ignored --nocapture --test-threads=1

cargo test --manifest-path hmux/Cargo.toml --package hmux-client --lib \
  --features terminal-state-stream recovery_journal::tests:: -- --test-threads=1
cargo test --manifest-path hmux/Cargo.toml --package hmux-client --lib \
  --features terminal-state-stream managed_rehost_successor_index::tests:: -- --test-threads=1
