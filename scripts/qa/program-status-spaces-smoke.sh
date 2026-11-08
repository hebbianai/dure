#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_PROGRAM_STATUS_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/program-status-spaces-client.mjs"
export DURE_QA_HOME_SETUP="scripts/qa/program-status-spaces-home-setup.mjs"
export DURE_QA_NAME="Program status on Spaces rows in WKWebView"
export DURE_QA_ARTIFACT_NAME="program-status-spaces"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaProgramStatusSpaces=$DURE_QA_PROGRAM_STATUS_PROOF"
exec node "$repo_root/scripts/run-with-build-storage.mjs" qa -- sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
