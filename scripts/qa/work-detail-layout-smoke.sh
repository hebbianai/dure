#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_WORK_DETAIL_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/work-detail-layout-client.mjs"
export DURE_QA_HOME_SETUP="scripts/qa/work-detail-layout-home-setup.mjs"
export DURE_QA_NAME="Work detail layout in WKWebView"
export DURE_QA_ARTIFACT_NAME="work-detail-layout"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaWorkDetailLayout=$DURE_QA_WORK_DETAIL_PROOF"
export DURE_QA_WINDOW_PLAN_JSON="[{\"label\":\"main\",\"title\":\"Dure Work Detail QA\",\"url\":\"$DURE_QA_WINDOW_URL\",\"width\":1280,\"height\":820,\"x\":-4000,\"y\":-2000,\"visible\":true,\"focus\":false,\"focusable\":false}]"
exec node "$repo_root/scripts/run-with-build-storage.mjs" qa -- sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
