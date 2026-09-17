#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_WEBVIEW_REALM_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/webview-realm-client.mjs"
export DURE_QA_NAME="WebView realm reload ownership"
export DURE_QA_ARTIFACT_NAME="webview-realm"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaWebviewRealm=$DURE_QA_WEBVIEW_REALM_PROOF"
export DURE_QA_WINDOW_PLAN_JSON="[{\"label\":\"main\",\"title\":\"Dure Realm QA\",\"url\":\"$DURE_QA_WINDOW_URL\",\"width\":1100,\"height\":800,\"x\":-4000,\"y\":-2000,\"visible\":true,\"focus\":false,\"focusable\":false}]"
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
