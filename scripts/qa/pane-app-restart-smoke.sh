#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_PANE_RESTART_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/pane-app-restart-client.mjs"
export DURE_QA_HOME_SETUP="scripts/qa/pane-app-restart-home-setup.mjs"
export DURE_QA_NAME="native pane app restart"
export DURE_QA_ARTIFACT_NAME="pane-app-restart"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaPaneAppRestart=$DURE_QA_PANE_RESTART_PROOF"
# Use the normal App root without activating the user's foreground window.
export DURE_QA_WINDOW_PLAN_JSON="[{\"label\":\"main\",\"title\":\"Pane restart QA\",\"url\":\"$DURE_QA_WINDOW_URL\",\"width\":1100,\"height\":800,\"x\":-3900,\"y\":-3900,\"visible\":true,\"focus\":false,\"focusable\":false}]"
exec node "$repo_root/scripts/run-with-build-storage.mjs" qa -- sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
