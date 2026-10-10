#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_WEBVIEW_DIAGNOSTICS_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/webview-diagnostics-client.mjs"
export DURE_QA_NAME="WebView diagnostic persistence"
export DURE_QA_ARTIFACT_NAME="webview-diagnostics"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaWebviewDiagnostics=$DURE_QA_WEBVIEW_DIAGNOSTICS_PROOF"
export DURE_QA_WINDOW_PLAN_JSON="[{\"label\":\"main\",\"title\":\"Dure Diagnostics QA\",\"url\":\"$DURE_QA_WINDOW_URL\",\"width\":800,\"height\":600,\"x\":-4000,\"y\":-2000,\"visible\":true,\"focus\":false,\"focusable\":false}]"
exec node "$repo_root/scripts/run-with-build-storage.mjs" qa -- sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
