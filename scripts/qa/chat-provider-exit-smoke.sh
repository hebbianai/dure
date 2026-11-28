#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_CHAT_PROVIDER_EXIT_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/chat-provider-exit-client.mjs"
export DURE_QA_NAME="Chat provider exit notice in WKWebView"
export DURE_QA_ARTIFACT_NAME="chat-provider-exit"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaChatProviderExit=$DURE_QA_CHAT_PROVIDER_EXIT_PROOF"
export DURE_QA_WINDOW_PLAN_JSON="[{\"label\":\"main\",\"title\":\"Dure Chat Provider Exit QA\",\"url\":\"$DURE_QA_WINDOW_URL\",\"width\":820,\"height\":600,\"x\":-4000,\"y\":-2000,\"visible\":true,\"focus\":false,\"focusable\":false}]"
exec node "$repo_root/scripts/run-with-build-storage.mjs" qa -- sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
