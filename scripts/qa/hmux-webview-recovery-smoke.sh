#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)

export HEBBIAN_QA_CLIENT="scripts/qa/hmux-webview-recovery-client.mjs"
export HEBBIAN_QA_NAME="hmux webview recovery smoke"
export HEBBIAN_QA_ARTIFACT_NAME="hmux-webview-recovery"
export HEBBIAN_QA_LAYER="exclusive_focus"
export DURE_QA_UNIQUE_APP_CHANNEL=1
exec sh "$repo_root/scripts/qa/lib/hmux-exclusive-focus-runner.sh"
