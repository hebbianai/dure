#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
export HEBBIAN_QA_CLIENT="scripts/qa/hmux-scrollback-client.mjs"
export HEBBIAN_QA_NAME="hmux scrollback attach and resize smoke"
export HEBBIAN_QA_LAYER="exclusive_scrollback"
exec sh "$repo_root/scripts/qa/lib/hmux-exclusive-focus-runner.sh"
