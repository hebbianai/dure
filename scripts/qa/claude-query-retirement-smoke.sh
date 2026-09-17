#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$repo_root"

expected_node_version=$(tr -d '[:space:]' < .node-version)
node_bin=$(node -p 'process.execPath')
if [ "$("$node_bin" -p 'process.versions.node')" != "$expected_node_version" ]; then
  echo "Claude Query retirement smoke requires Node $expected_node_version" >&2
  exit 1
fi
corepack pnpm --dir crates/dure-app/control-plane/provider-drivers/claude install \
  --frozen-lockfile --ignore-scripts

app_target_root=${CARGO_TARGET_DIR:-"$repo_root/crates/dure-app/target"}
hmux_target_root=${CARGO_TARGET_DIR:-"$repo_root/hmux/target"}
if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  app_target_root="$app_target_root/$CARGO_BUILD_TARGET"
  hmux_target_root="$hmux_target_root/$CARGO_BUILD_TARGET"
fi
cargo build --locked --manifest-path hmux/Cargo.toml --package hmux-runtime
cargo build --locked --manifest-path crates/dure-app/Cargo.toml \
  --package dure-control-plane --bin dure-claude-process-relay

for test in \
  query_retirement_is_durable_before_an_exact_hmux_stop_refusal \
  dead_attached_query_retires_by_absence_proof
do
  DURE_NODE_BIN="$node_bin" \
  DURE_HMUX_RUNTIME_BIN="$hmux_target_root/debug/hmux-runtime" \
  DURE_CLAUDE_PROCESS_RELAY_BIN="$app_target_root/debug/dure-claude-process-relay" \
    cargo test --locked --manifest-path crates/dure-app/Cargo.toml \
      --package dure-control-plane --lib \
      "claude_structured_runtime::recovery_tests::$test" -- --ignored --exact --nocapture
done
