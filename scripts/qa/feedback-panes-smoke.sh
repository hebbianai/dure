#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_FEEDBACK_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/feedback-panes-client.mjs"
export DURE_QA_NAME="Feedback pane profile consistency and action recovery"
export DURE_QA_ARTIFACT_NAME="feedback-panes"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaWindowSmokeController=1&qaFeedbackPanes=$DURE_QA_FEEDBACK_PROOF"
exec node "$repo_root/scripts/run-with-build-storage.mjs" qa -- sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
