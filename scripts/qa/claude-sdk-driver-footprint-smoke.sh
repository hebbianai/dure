#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
cd "$repo_root"

driver_dir="$repo_root/crates/dure-app/control-plane/provider-drivers/claude"
expected_node_version=$(tr -d '[:space:]' < "$repo_root/.node-version")

node_bin=$(node -p 'process.execPath')
if [ ! -x "$node_bin" ]; then
  echo "Claude SDK footprint smoke: Node is unavailable" >&2
  exit 1
fi

actual_node_version=$("$node_bin" -p 'process.versions.node')
if [ "$actual_node_version" != "$expected_node_version" ]; then
  echo "Claude SDK footprint smoke: expected Node $expected_node_version, found $actual_node_version" >&2
  exit 1
fi

corepack pnpm --dir "$driver_dir" install \
  --frozen-lockfile \
  --ignore-scripts

target_triple=${CARGO_BUILD_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}
target_root=${CARGO_TARGET_DIR:-"$repo_root/hmux/target"}
if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  target_root="$target_root/$target_triple"
fi

cargo build --locked --manifest-path hmux/Cargo.toml --package hmux-runtime

hmux_runtime="$target_root/debug/hmux-runtime"
if [ ! -x "$hmux_runtime" ]; then
  echo "Claude SDK footprint smoke: Hmux runtime is unavailable" >&2
  exit 1
fi

run_footprint_test() {
  test_name=$1
  DURE_HMUX_RUNTIME_BIN="$hmux_runtime" \
  DURE_NODE_BIN="$node_bin" \
    cargo test --locked --manifest-path crates/dure-app/Cargo.toml \
      --package dure-control-plane \
      --test claude_sdk_import_hmux \
      "$test_name" \
      -- --ignored --exact --nocapture
}

run_footprint_test \
  claude_sdk_driver_footprint_matrix_1_5_20_preserves_exact_hmux_ownership
run_footprint_test \
  shared_claude_sdk_host_with_hmux_native_relays_measures_1_5_20
