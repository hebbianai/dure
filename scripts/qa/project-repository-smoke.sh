#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_REPOSITORY_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/project-repository-client.mjs"
export DURE_QA_HOME_SETUP="scripts/qa/project-repository-setup.mjs"
export DURE_QA_NAME="Project repository refresh"
export DURE_QA_ARTIFACT_NAME="project-repository"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaProjectRepository=$DURE_QA_REPOSITORY_PROOF"
export DURE_QA_WINDOW_PLAN_JSON="[{\"label\":\"main\",\"title\":\"Dure Repository QA\",\"url\":\"$DURE_QA_WINDOW_URL\",\"width\":1100,\"height\":850,\"x\":-4000,\"y\":-2000,\"visible\":true,\"focus\":false,\"focusable\":false}]"
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
