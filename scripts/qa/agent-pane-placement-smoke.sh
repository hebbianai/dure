#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_AGENT_PLACEMENT_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/agent-pane-placement-client.mjs"
export DURE_QA_NAME="Adaptive agent pane placement"
export DURE_QA_ARTIFACT_NAME="agent-pane-placement"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaAgentPanePlacement=$DURE_QA_AGENT_PLACEMENT_PROOF"
export DURE_QA_WINDOW_PLAN_JSON="[{\"label\":\"main\",\"title\":\"Dure Placement QA\",\"url\":\"$DURE_QA_WINDOW_URL\",\"width\":1600,\"height\":900,\"x\":-4000,\"y\":-2000,\"visible\":true,\"focus\":false,\"focusable\":false}]"
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
