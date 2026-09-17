#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
cd "$repo_root"

mode=${STRUCTURED_CHAT_SCALE_MODE:-deterministic}
case "$mode" in
  deterministic | real) ;;
  *)
    echo "Structured Chat runtime scale: mode must be deterministic or real" >&2
    exit 2
    ;;
esac
provider=${STRUCTURED_CHAT_SCALE_PROVIDER:-all}
case "$provider" in
  all | claude | codex) ;;
  *)
    echo "Structured Chat runtime scale: provider must be all, claude, or codex" >&2
    exit 2
    ;;
esac

if [ "$provider" != codex ]; then
  driver_dir="$repo_root/crates/dure-app/control-plane/provider-drivers/claude"
  expected_node_version=$(tr -d '[:space:]' < "$repo_root/.node-version")
  node_bin=$(node -p 'process.execPath')
  actual_node_version=$("$node_bin" -p 'process.versions.node')
  if [ "$actual_node_version" != "$expected_node_version" ]; then
    echo "Structured Chat runtime scale: expected Node $expected_node_version, found $actual_node_version" >&2
    exit 1
  fi

  corepack pnpm --dir "$driver_dir" install \
    --frozen-lockfile \
    --ignore-scripts
fi

target_triple=${CARGO_BUILD_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}
app_target_root=${CARGO_TARGET_DIR:-"$repo_root/crates/dure-app/target"}
hmux_target_root=${CARGO_TARGET_DIR:-"$repo_root/hmux/target"}
if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  app_target_root="$app_target_root/$target_triple"
  hmux_target_root="$hmux_target_root/$target_triple"
fi

if [ "$provider" != claude ]; then
  cargo build --locked --manifest-path crates/dure-app/Cargo.toml \
    --package dure-control-plane \
    --bin dure-control-plane \
    --example codex_app_server_fixture
fi
if [ "$provider" != codex ]; then
  cargo build --locked --manifest-path crates/dure-app/Cargo.toml \
    --package dure-control-plane \
    --bin dure-claude-process-relay
fi
cargo build --locked --manifest-path hmux/Cargo.toml --package hmux-runtime

hmux_runtime="$hmux_target_root/debug/hmux-runtime"
if [ ! -x "$hmux_runtime" ]; then
  echo "Structured Chat runtime scale: required executable is unavailable: $hmux_runtime" >&2
  exit 1
fi
if [ "$provider" != claude ]; then
  provider_launcher="$app_target_root/debug/dure-control-plane"
  codex_fixture="$app_target_root/debug/examples/codex_app_server_fixture"
  for executable in "$provider_launcher" "$codex_fixture"; do
    if [ ! -x "$executable" ]; then
      echo "Structured Chat runtime scale: required executable is unavailable: $executable" >&2
      exit 1
    fi
  done
fi

claude_test=initialized_claude_runtime_matrix_1_5_20_replaces_backend_and_cleans_exactly
codex_test=managed_structured_runtime::tests::initialized_codex_runtime_matrix_1_5_20_reattaches_backend_and_cleans_exactly

if [ "$mode" = deterministic ]; then
  if [ "$provider" != codex ]; then
    DURE_NODE_BIN="$node_bin" \
    DURE_HMUX_RUNTIME_BIN="$hmux_runtime" \
      cargo test --locked --manifest-path crates/dure-app/Cargo.toml \
        --package dure-control-plane \
        --test claude_structured_runtime_scale_hmux \
        "$claude_test" -- --ignored --exact --nocapture
  fi

  if [ "$provider" != claude ]; then
    DURE_HMUX_RUNTIME_BIN="$hmux_runtime" \
    DURE_PROVIDER_LAUNCHER_BIN="$provider_launcher" \
    DURE_CODEX_APP_SERVER_FIXTURE_BIN="$codex_fixture" \
      cargo test --locked --manifest-path crates/dure-app/Cargo.toml \
        --package dure-control-plane \
        --lib "$codex_test" -- --ignored --exact --nocapture
  fi
  exit 0
fi

if [ "$provider" != codex ]; then
  : "${DURE_SCALE_CLAUDE_RUNTIME_SOURCE:?real Claude mode requires DURE_SCALE_CLAUDE_RUNTIME_SOURCE}"
  : "${DURE_SCALE_CLAUDE_CONFIG_DIR:?real Claude mode requires DURE_SCALE_CLAUDE_CONFIG_DIR}"
  env \
    -u ANTHROPIC_API_KEY \
    -u ANTHROPIC_AUTH_TOKEN \
    -u CLAUDE_CODE_OAUTH_TOKEN \
    DURE_NODE_BIN="$node_bin" \
    DURE_HMUX_RUNTIME_BIN="$hmux_runtime" \
    DURE_SCALE_CLAUDE_RUNTIME_SOURCE="$DURE_SCALE_CLAUDE_RUNTIME_SOURCE" \
    DURE_SCALE_CLAUDE_CONFIG_DIR="$DURE_SCALE_CLAUDE_CONFIG_DIR" \
      cargo test --locked --manifest-path crates/dure-app/Cargo.toml \
        --package dure-control-plane \
        --test claude_structured_runtime_scale_hmux \
        "$claude_test" -- --ignored --exact --nocapture
fi

if [ "$provider" != claude ]; then
  : "${DURE_SCALE_CODEX_BIN:?real Codex mode requires DURE_SCALE_CODEX_BIN}"
  : "${DURE_SCALE_DURE_HOME:?real Codex mode requires DURE_SCALE_DURE_HOME}"
  : "${DURE_SCALE_CODEX_HOME:?real Codex mode requires DURE_SCALE_CODEX_HOME}"
  : "${DURE_SCALE_CODEX_SQLITE_HOME:?real Codex mode requires the canonical DURE_SCALE_CODEX_SQLITE_HOME}"
  env \
    -u CODEX_ACCESS_TOKEN \
    -u CODEX_API_KEY \
    -u OPENAI_API_KEY \
    CODEX_HOME="$DURE_SCALE_CODEX_HOME" \
    CODEX_SQLITE_HOME="$DURE_SCALE_CODEX_SQLITE_HOME" \
    DURE_HMUX_RUNTIME_BIN="$hmux_runtime" \
    DURE_PROVIDER_LAUNCHER_BIN="$provider_launcher" \
    DURE_SCALE_CODEX_BIN="$DURE_SCALE_CODEX_BIN" \
    DURE_SCALE_DURE_HOME="$DURE_SCALE_DURE_HOME" \
    DURE_SCALE_CODEX_HOME="$DURE_SCALE_CODEX_HOME" \
    DURE_SCALE_CODEX_SQLITE_HOME="$DURE_SCALE_CODEX_SQLITE_HOME" \
      cargo test --locked --manifest-path crates/dure-app/Cargo.toml \
        --package dure-control-plane \
        --lib "$codex_test" -- --ignored --exact --nocapture
fi
