#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
export HEBBIAN_QA_CLIENT="scripts/qa/hmux-focus-frame-atomic-client.mjs"
export HEBBIAN_QA_NAME="hmux focus frame atomic smoke"
export HEBBIAN_QA_ARTIFACT_NAME="hmux-focus-frame-atomic"
export HEBBIAN_QA_LAYER="exclusive_focus_frame"
exec sh "$repo_root/scripts/qa/lib/hmux-exclusive-focus-runner.sh"
