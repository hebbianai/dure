#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
export DURE_QA_CLIENT="scripts/qa/hmux-window-background-client.mjs"
export DURE_QA_NAME="hmux background window smoke"
export DURE_QA_ARTIFACT_NAME="hmux-window-background"
export DURE_QA_LAYER="background"
exec sh "$repo_root/scripts/qa/lib/hmux-window-focus-runner.sh"
