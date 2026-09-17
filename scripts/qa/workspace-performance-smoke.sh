#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)

export DURE_QA_CLIENT="scripts/qa/workspace-performance-client.mjs"
export DURE_QA_NAME="Dure native workspace performance"
export DURE_QA_ARTIFACT_NAME="workspace-performance"
export DURE_QA_LAYER="exclusive_focus_workspace_performance"
export DURE_QA_WINDOW_TITLE="Dure workspace performance QA"
: "${DURE_QA_PERFORMANCE_SCENARIO:=baseline_15}"
: "${DURE_QA_PERFORMANCE_PHASE:=full}"
export DURE_QA_PERFORMANCE_SCENARIO
export DURE_QA_PERFORMANCE_PHASE
export DURE_QA_WINDOW_URL="index.html?qaWorkspacePerformance=1&scenario=$DURE_QA_PERFORMANCE_SCENARIO&phase=$DURE_QA_PERFORMANCE_PHASE"
if [ -z "${DURE_QA_WINDOW_PLAN_JSON:-}" ]; then
  DURE_QA_WINDOW_PLAN_JSON="[{\"label\":\"main\",\"title\":\"Dure workspace performance QA\",\"url\":\"$DURE_QA_WINDOW_URL\",\"width\":1200,\"height\":800,\"x\":-4000,\"y\":-4000,\"visible\":true,\"focus\":true,\"focusable\":true}]"
fi
export DURE_QA_WINDOW_PLAN_JSON
export VITE_DURE_WORKSPACE_PERFORMANCE_QA=1
export DURE_QA_HOME_SETUP="$repo_root/scripts/qa/workspace-performance-home-setup.mjs"
export SHELL=/bin/zsh
if [ "$DURE_QA_PERFORMANCE_PHASE" = "native_focus" ]; then
  export DURE_QA_CLIENT="scripts/qa/workspace-native-focus-client.mjs"
  export DURE_QA_LAYER="exclusive_focus_workspace_native_input"
  export DURE_QA_UNIQUE_APP_CHANNEL=1
  export HEBBIAN_QA_REQUIRE_EXECUTION=${DURE_QA_REQUIRE_EXECUTION:-${HEBBIAN_QA_REQUIRE_EXECUTION:-0}}
  export DURE_QA_WINDOW_PLAN_JSON="[{\"label\":\"main\",\"title\":\"Dure workspace performance QA\",\"url\":\"$DURE_QA_WINDOW_URL\",\"width\":1200,\"height\":800,\"x\":80,\"y\":80,\"visible\":true,\"focus\":true,\"focusable\":true}]"
  exec sh "$repo_root/scripts/qa/lib/hmux-exclusive-focus-runner.sh"
fi
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
