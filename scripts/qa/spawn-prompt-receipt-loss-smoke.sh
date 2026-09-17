#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "spawn prompt receipt-loss smoke: macOS is required" >&2
  exit 1
fi

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
cd "$repo_root"

qa_tmp_root=$(
  CDPATH= cd -- "${TMPDIR:-/tmp}" &&
    pwd -P
)
qa_project=$(mktemp -d "$qa_tmp_root/dure-spawn-prompt-project.XXXXXX")
cleanup() {
  rm -f "$repo_root/qa.autorun" "$repo_root/qa.log"
  case "$qa_project" in
    "$qa_tmp_root"/dure-spawn-prompt-project.*)
      chmod -R u+w "$qa_project"
      rm -r -- "$qa_project"
      ;;
    *)
      echo "spawn prompt receipt-loss smoke: refusing unexpected cleanup target" >&2
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM

git -C "$qa_project" init -q -b main
git -C "$qa_project" -c user.email=qa@qa -c user.name=qa \
  -c commit.gpgsign=false commit -q --allow-empty -m base

qa_prompt="receipt-loss-$$-one-shot"
qa_prompt_digest=$(node -e '
  const crypto = require("node:crypto");
  process.stdout.write(`sha256:${crypto.createHash("sha256").update(process.argv[1]).digest("hex")}`);
' "$qa_prompt")

printf 'localproject=%s\n' "$qa_project" >qa.autorun
rm -f qa.log

export DURE_QA_CLIENT="$repo_root/scripts/qa/spawn-prompt-receipt-loss-client.mjs"
export DURE_QA_NAME="Spawn prompt receipt-loss smoke"
export DURE_QA_ARTIFACT_NAME="spawn-prompt-receipt-loss"
export DURE_QA_LAYER="control_plane_spawn_receipt_loss"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_WINDOW_TITLE="Dure Spawn Prompt Receipt-loss QA"
export DURE_QA_PROJECT="$qa_project"
export DURE_QA_PROMPT="$qa_prompt"
export DURE_QA_FAIL_PROMPT_SUCCESS_APPEND_ONCE="$qa_prompt_digest"
export DURE_QA_PROVIDER_BIN="$repo_root/scripts/qa/fake-provider"
export HEBBIAN_QA_PROVIDER_BIN="$DURE_QA_PROVIDER_BIN"
export PATH="$DURE_QA_PROVIDER_BIN:$PATH"

sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
