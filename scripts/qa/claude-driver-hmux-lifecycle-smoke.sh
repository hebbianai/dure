#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
cd "$repo_root"

target_triple=${CARGO_BUILD_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}
target_root=${CARGO_TARGET_DIR:-"$repo_root/hmux/target"}
if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  target_root="$target_root/$target_triple"
fi

cargo build --locked --manifest-path hmux/Cargo.toml --package hmux-runtime

hmux_runtime="$target_root/debug/hmux-runtime"
if [ ! -x "$hmux_runtime" ]; then
  echo "Claude driver Hmux lifecycle smoke: runtime is unavailable" >&2
  exit 1
fi

node_bin=$(node -p 'process.execPath')
if [ ! -x "$node_bin" ]; then
  echo "Claude driver Hmux lifecycle smoke: Node is unavailable" >&2
  exit 1
fi

DURE_HMUX_RUNTIME_BIN="$hmux_runtime" \
DURE_NODE_BIN="$node_bin" \
  cargo test --locked --manifest-path crates/dure-app/Cargo.toml \
    --package dure-control-plane \
    --test claude_driver_hmux_lifecycle \
    claude_driver_is_one_detached_hmux_root_with_no_codex_app_server \
    -- --ignored --exact --nocapture
