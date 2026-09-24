#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_REHOST_SYNC_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/managed-rehost-sync-client.mjs"
export DURE_QA_NAME="Managed conversation continuation persistence"
export DURE_QA_ARTIFACT_NAME="managed-conversation-continuation"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaWindowSmokeController=1&qaManagedRehostSync=$DURE_QA_REHOST_SYNC_PROOF&conversationOnly=1"
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
