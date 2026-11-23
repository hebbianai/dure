#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_CHAT_LARGE_WINDOW_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/chat-large-window-client.mjs"
export DURE_QA_NAME="native chat large window"
export DURE_QA_ARTIFACT_NAME="chat-large-window"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaWindowSmokeController=1&qaChatLargeWindow=$DURE_QA_CHAT_LARGE_WINDOW_PROOF"
exec node "$repo_root/scripts/run-with-build-storage.mjs" qa -- sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
