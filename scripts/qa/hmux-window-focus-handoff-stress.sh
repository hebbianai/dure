#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
export HEBBIAN_QA_CLIENT="scripts/qa/hmux-window-focus-client.mjs"
export HEBBIAN_QA_NAME="hmux window focus handoff stress"
export HEBBIAN_QA_ARTIFACT_NAME="hmux-window-focus-handoff"
export HEBBIAN_QA_LAYER="exclusive_focus"
export HMUX_WINDOW_FOCUS_HANDOFF_STEPS=${HMUX_WINDOW_FOCUS_HANDOFF_STEPS:-60}
exec sh "$repo_root/scripts/qa/lib/hmux-exclusive-focus-runner.sh"
