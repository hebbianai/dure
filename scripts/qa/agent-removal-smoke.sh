#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_REAL_GIT=$(command -v git)
export PATH="$repo_root/scripts/qa/agent-removal-tools:$PATH"
export DURE_QA_PROVIDER_BIN="$repo_root/scripts/qa/fake-provider"
export HEBBIAN_QA_PROVIDER_BIN="$DURE_QA_PROVIDER_BIN"
export PATH="$DURE_QA_PROVIDER_BIN:$PATH"
export VITE_DURE_AGENT_REMOVAL_QA_RUN_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="$repo_root/scripts/qa/agent-removal-client.mjs"
export DURE_QA_HOME_SETUP="$repo_root/scripts/qa/agent-removal-home-setup.mjs"
export DURE_QA_NAME="Agent removal during projection refresh"
export DURE_QA_ARTIFACT_NAME="agent-removal"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER=background
export DURE_QA_WINDOW_PLAN_JSON='[{"label":"main","title":"Dure Agent removal QA","url":"index.html","width":1100,"height":800,"x":-4000,"y":-2000,"visible":true,"focus":false,"focusable":false}]'
exec node "$repo_root/scripts/run-with-build-storage.mjs" qa -- sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
