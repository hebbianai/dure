#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_QUICK_START_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/repository-quick-start-client.mjs"
export DURE_QA_HOME_SETUP="scripts/qa/repository-quick-start-home-setup.mjs"
export DURE_QA_NAME="repository quick-start failure and recovery"
export DURE_QA_ARTIFACT_NAME="repository-quick-start"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaRepositoryQuickStart=$DURE_QA_QUICK_START_PROOF&scenario=invalid-profile"
export DURE_QA_WINDOW_PLAN_JSON="[{\"label\":\"main\",\"title\":\"Dure Quick-start QA\",\"url\":\"$DURE_QA_WINDOW_URL\",\"width\":1100,\"height\":800,\"x\":-4000,\"y\":-2000,\"visible\":true,\"focus\":false,\"focusable\":false}]"
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
