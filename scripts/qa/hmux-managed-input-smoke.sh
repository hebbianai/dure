#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
cd "$repo_root"
: "${DURE_HMUX_TEST_STATE_ROOT:?run through pnpm test:hmux-managed-input}"

contention=0
repetitions=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --contention) contention=1; shift ;;
    --repeat)
      [ "$#" -ge 2 ] || { echo "--repeat requires 1..8" >&2; exit 2; }
      case "$2" in
        1 | 2 | 3 | 4 | 5 | 6 | 7 | 8) repetitions=$2 ;;
        *) echo "--repeat requires 1..8" >&2; exit 2 ;;
      esac
      shift 2
      ;;
    *) echo "usage: pnpm test:hmux-managed-input [--contention] [--repeat 1..8]" >&2; exit 2 ;;
  esac
done

target_triple=$(rustc -vV | sed -n 's/^host: //p')
if [ -z "$target_triple" ] || [ "${CARGO_BUILD_TARGET:-$target_triple}" != "$target_triple" ]; then
  echo "managed input smoke requires the current native Rust target" >&2
  exit 1
fi
case "$(uname -s)" in
  Darwin | Linux) ;;
  *) echo "managed input smoke requires a native Unix target" >&2; exit 1 ;;
esac

pnpm hmux:runtime:stage:dev
qa_home="$DURE_HMUX_TEST_STATE_ROOT/managed-input-home"
mkdir "$qa_home"
mkdir "$qa_home/.dure"
chmod 700 "$qa_home" "$qa_home/.dure"
qa_channel="qa-managed-input-$(basename "$DURE_HMUX_TEST_STATE_ROOT" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
hmux_cli="$repo_root/src-tauri/binaries/hmux-$target_triple"
runtime="$repo_root/src-tauri/binaries/hmux-runtime-$target_triple"
build_id=$(node scripts/hmux-dev-build-id.mjs)
# Keep immutable CLI/SDK build artifacts outside the bounded session census.
cli_home="$repo_root/artifacts/qa/command-input-cli"
install_root="$cli_home/install"
mkdir -p "$cli_home" "$qa_home/.local/share/hebbian-ide-cli/channels"
chmod 700 "$cli_home"
run_isolated() {
  env HOME="$qa_home" \
    DURE_HOME="$qa_home/.dure" \
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

repetition=1
while [ "$repetition" -le "$repetitions" ]; do
  echo "managed input repetition $repetition/$repetitions contention=$contention"
  run_isolated env HMUX_RUNTIME="$runtime" HMUX_CLI="$hmux_cli" \
    DURE_QA_COMMAND_INPUT_CONTENTION="$contention" \
    cargo test --locked --manifest-path src-tauri/Cargo.toml --lib \
      hmux::command_input_smoke::native_managed_dure_command_preserves_semantic_submit \
      -- --ignored --exact --nocapture --test-threads=1
  repetition=$((repetition + 1))
done
