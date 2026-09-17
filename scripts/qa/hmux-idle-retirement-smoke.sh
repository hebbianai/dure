#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "hmux idle retirement smoke: macOS is required" >&2
  exit 1
fi

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

qa_tmp_root=$(
  CDPATH= cd -- "${TMPDIR:-/tmp}" &&
    pwd -P
)
qa_project=$(mktemp -d "$qa_tmp_root/hebbian-hmux-idle-retirement.XXXXXX")
cleanup() {
  rm -f "$repo_root/qa.autorun" "$repo_root/qa.log"
  case "$qa_project" in
    "$qa_tmp_root"/hebbian-hmux-idle-retirement.*)
      rm -rf -- "$qa_project"
      ;;
    *)
      echo "hmux idle retirement smoke: refusing unexpected cleanup target" >&2
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM

git -C "$qa_project" init -q -b main
git -C "$qa_project" -c user.email=qa@qa -c user.name=qa \
  -c commit.gpgsign=false commit -q --allow-empty -m base

cargo build \
  --manifest-path hmux/Cargo.toml \
  --package hmux-cli \
  --package hmux-runtime

hmux_cli="$target_root/debug/hmux"
hmux_runtime="$target_root/debug/hmux-runtime"
if [ ! -x "$hmux_cli" ] || [ ! -x "$hmux_runtime" ]; then
  echo "hmux idle retirement smoke: staged binaries are unavailable" >&2
  exit 1
fi

rm -f qa.autorun qa.log
HEBBIAN_QA_CLIENT="$repo_root/scripts/qa/hmux-idle-retirement-client.mjs" \
HEBBIAN_QA_NAME="Hmux idle retirement smoke" \
HEBBIAN_QA_ARTIFACT_NAME="hmux-idle-retirement" \
HEBBIAN_QA_LAYER="retirement" \
HEBBIAN_QA_PROJECT="$qa_project" \
HEBBIAN_QA_HMUX_CLI="$hmux_cli" \
HEBBIAN_QA_HMUX_RUNTIME="$hmux_runtime" \
  sh scripts/qa/lib/tauri-app-runner.sh
