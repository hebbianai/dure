#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../../.." &&
    pwd
)

export DURE_QA_ARTIFACT_NAME=${DURE_QA_ARTIFACT_NAME:-${HEBBIAN_QA_ARTIFACT_NAME:-hmux-window-focus}}
export DURE_QA_WINDOW_TITLE=${DURE_QA_WINDOW_TITLE:-${HEBBIAN_QA_WINDOW_TITLE:-Dure Hmux QA}}
export DURE_QA_WINDOW_URL=${DURE_QA_WINDOW_URL:-${HEBBIAN_QA_WINDOW_URL:-index.html?qaWindowSmokeController=1}}
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
