#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_WEBVIEW_STORAGE_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/webview-storage-client.mjs"
export DURE_QA_HOME_SETUP="scripts/qa/webview-storage-setup.mjs"
export DURE_QA_NAME="WebView storage isolation"
export DURE_QA_ARTIFACT_NAME="webview-storage"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="src/qa/webviewStorage.html?proof=$DURE_QA_WEBVIEW_STORAGE_PROOF"
exec node "$repo_root/scripts/run-with-build-storage.mjs" qa -- sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
