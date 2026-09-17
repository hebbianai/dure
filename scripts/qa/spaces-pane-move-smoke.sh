#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_SPACES_MOVE_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/spaces-pane-move-client.mjs"
export DURE_QA_HOME_SETUP="scripts/qa/workspace-performance-home-setup.mjs"
export DURE_QA_NAME="Spaces payload-owned drop in WKWebView"
export DURE_QA_ARTIFACT_NAME="spaces-pane-move"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaSpacesPaneMove=$DURE_QA_SPACES_MOVE_PROOF"
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
