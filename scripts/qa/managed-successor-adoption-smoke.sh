#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_SUCCESSOR_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/managed-successor-adoption-client.mjs"
export DURE_QA_HOME_SETUP="scripts/qa/managed-successor-adoption-home-setup.mjs"
export DURE_QA_NAME="managed successor adoption"
export DURE_QA_ARTIFACT_NAME="managed-successor-adoption"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export SHELL=/bin/zsh
export DURE_QA_WINDOW_URL="index.html?qaWindowSmokeController=1&qaManagedSuccessorAdoption=$DURE_QA_SUCCESSOR_PROOF"
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
