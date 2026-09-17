#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_CLIENT="scripts/qa/pane-focus-history-client.mjs"
export DURE_QA_HOME_SETUP="$repo_root/scripts/qa/pane-focus-history-home-setup.mjs"
export DURE_QA_NAME="Dure native pane focus history"
export HEBBIAN_QA_NAME="$DURE_QA_NAME"
export DURE_QA_ARTIFACT_NAME="pane-focus-history"
export DURE_QA_LAYER="exclusive_focus_pane_history"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_WINDOW_TITLE="Dure pane focus history QA"
export DURE_QA_WINDOW_URL="index.html?qaPaneFocusHistory=1"
export DURE_QA_WINDOW_PLAN_JSON='[{"label":"main","title":"Dure pane focus history QA","url":"index.html?qaPaneFocusHistory=1","width":900,"height":640,"visible":false,"focus":false,"focusable":true},{"label":"win-focus-sibling","title":"Dure pane focus sibling QA","url":"index.html?qaWindowSmokeController=1","width":360,"height":240,"visible":false,"focus":false,"focusable":true}]'
export VITE_DURE_PANE_FOCUS_HISTORY_QA=1
VITE_DURE_PANE_FOCUS_HISTORY_QA_RUN_ID=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
export VITE_DURE_PANE_FOCUS_HISTORY_QA_RUN_ID
export HEBBIAN_QA_REQUIRE_EXECUTION=${DURE_QA_REQUIRE_EXECUTION:-${HEBBIAN_QA_REQUIRE_EXECUTION:-0}}
exec sh "$repo_root/scripts/qa/lib/hmux-exclusive-focus-runner.sh"
