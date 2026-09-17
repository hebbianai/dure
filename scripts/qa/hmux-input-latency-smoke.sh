#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
export HEBBIAN_QA_CLIENT="scripts/qa/hmux-input-latency-client.mjs"
export HEBBIAN_QA_NAME="hmux input latency smoke"
export HEBBIAN_QA_ARTIFACT_NAME="hmux-input-latency"
export HEBBIAN_QA_LAYER="exclusive_focus_input_latency"
export DURE_QA_SWIFTC_BIN=${DURE_QA_SWIFTC_BIN:-/usr/bin/swiftc}
exec sh "$repo_root/scripts/qa/lib/hmux-exclusive-focus-runner.sh"
