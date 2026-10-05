#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_TAB_REORDER_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/desktop-tab-reorder-client.mjs"
export DURE_QA_NAME="Space tab reordering in WKWebView"
export DURE_QA_ARTIFACT_NAME="desktop-tab-reorder"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaDesktopTabReorder=$DURE_QA_TAB_REORDER_PROOF"
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
