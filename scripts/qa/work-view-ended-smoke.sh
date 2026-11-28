#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_WORK_VIEW_ENDED_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/work-view-ended-client.mjs"
export DURE_QA_HOME_SETUP="scripts/qa/work-view-ended-home-setup.mjs"
export DURE_QA_NAME="Work view ended agents in WKWebView"
export DURE_QA_ARTIFACT_NAME="work-view-ended"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaWorkViewEnded=$DURE_QA_WORK_VIEW_ENDED_PROOF"
export DURE_QA_WINDOW_PLAN_JSON="[{\"label\":\"main\",\"title\":\"Dure Work View QA\",\"url\":\"$DURE_QA_WINDOW_URL\",\"width\":1280,\"height\":820,\"x\":-4000,\"y\":-2000,\"visible\":true,\"focus\":false,\"focusable\":false}]"
exec node "$repo_root/scripts/run-with-build-storage.mjs" qa -- sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
