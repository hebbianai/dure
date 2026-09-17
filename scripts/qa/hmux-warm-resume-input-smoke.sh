#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
export HEBBIAN_QA_CLIENT="scripts/qa/hmux-warm-resume-input-client.mjs"
export HEBBIAN_QA_NAME="hmux warm resume input smoke"
export HEBBIAN_QA_ARTIFACT_NAME="hmux-warm-resume-input"
export HEBBIAN_QA_LAYER="warm_resume_input"
exec sh "$repo_root/scripts/qa/lib/hmux-exclusive-focus-runner.sh"
