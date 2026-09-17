#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
cd "$repo_root"

expected_node_version=$(tr -d '[:space:]' < "$repo_root/.node-version")
node_bin=$(node -p 'process.execPath')
actual_node_version=$("$node_bin" -p 'process.versions.node')
if [ "$actual_node_version" != "$expected_node_version" ]; then
  echo "Claude process relay smoke: expected Node $expected_node_version, found $actual_node_version" >&2
  exit 1
fi

target_triple=${CARGO_BUILD_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}
app_target_root=${CARGO_TARGET_DIR:-"$repo_root/crates/dure-app/target"}
hmux_target_root=${CARGO_TARGET_DIR:-"$repo_root/hmux/target"}
if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  app_target_root="$app_target_root/$target_triple"
  hmux_target_root="$hmux_target_root/$target_triple"
fi

cargo build --locked --manifest-path crates/dure-app/Cargo.toml \
  --package dure-control-plane \
  --bin dure-claude-process-relay
cargo build --locked --manifest-path hmux/Cargo.toml --package hmux-runtime

relay_bin="$app_target_root/debug/dure-claude-process-relay"
hmux_runtime="$hmux_target_root/debug/hmux-runtime"
if [ ! -x "$relay_bin" ] || [ ! -x "$hmux_runtime" ]; then
  echo "Claude process relay smoke: required native binary is unavailable" >&2
  exit 1
fi

DURE_CLAUDE_PROCESS_RELAY_BIN="$relay_bin" \
  "$node_bin" --test \
    crates/dure-app/control-plane/provider-drivers/claude/relay-spawned-process.test.mjs

DURE_HMUX_RUNTIME_BIN="$hmux_runtime" \
DURE_NODE_BIN="$node_bin" \
  cargo test --locked --manifest-path crates/dure-app/Cargo.toml \
    --package dure-control-plane \
    --test claude_process_relay_hmux \
    native_claude_relay_stays_inside_one_exact_hmux_generation \
    -- --ignored --exact --nocapture
