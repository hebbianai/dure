#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../../.." &&
    pwd
)

: "${DURE_NATIVE_MEDIA_OUTPUT:?DURE_NATIVE_MEDIA_OUTPUT is required}"
: "${DURE_NATIVE_MEDIA_PROOF:?DURE_NATIVE_MEDIA_PROOF is required}"
: "${DURE_NATIVE_MEDIA_SCENARIO:?DURE_NATIVE_MEDIA_SCENARIO is required}"
: "${DURE_QA_WINDOW_PLAN_JSON:?DURE_QA_WINDOW_PLAN_JSON is required}"

export DURE_QA_CLIENT="$repo_root/tools/media-capture/native/capture-client.mjs"
export DURE_QA_NAME="Dure native multi-window media"
export DURE_QA_ARTIFACT_NAME="native-multi-window"
export DURE_QA_ARTIFACT_ROOT="$DURE_NATIVE_MEDIA_OUTPUT/qa"
export DURE_QA_LAYER="exclusive_focus_native_media"
export DURE_QA_REQUIRE_EXECUTION=1
export DURE_QA_EXCLUSIVE_LOCK_WAIT_SECONDS=300
export DURE_QA_ROOT_RETIREMENT_CAPABILITY="hard_process_containment_v1"

exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
