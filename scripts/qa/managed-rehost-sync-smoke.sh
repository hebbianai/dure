#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_REHOST_SYNC_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/managed-rehost-sync-client.mjs"
export DURE_QA_NAME="managed rehost window sync"
export DURE_QA_ARTIFACT_NAME="managed-rehost-sync"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaWindowSmokeController=1&qaManagedRehostSync=$DURE_QA_REHOST_SYNC_PROOF"
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
