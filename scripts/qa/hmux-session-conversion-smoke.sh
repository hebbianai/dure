#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "hmux session conversion smoke: macOS is required" >&2
  exit 1
fi

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
cd "$repo_root"

# Credential copying is opt-in to an explicitly chosen test account. Never
# infer approval from the provider profile of the invoking agent.
: "${HEBBIAN_QA_REAL_CODEX_HOME:?Set HEBBIAN_QA_REAL_CODEX_HOME to the approved test account home}"
codex_bin=$(command -v codex)
claude_bin=$(command -v claude)
export HEBBIAN_QA_REAL_CODEX_HOME
export HEBBIAN_QA_CODEX_BIN="$codex_bin"
export HEBBIAN_QA_CLAUDE_BIN="$claude_bin"
export DURE_QA_CLIENT="$repo_root/scripts/qa/hmux-session-conversion-client.mjs"
export DURE_QA_HOME_SETUP="$repo_root/scripts/qa/hmux-session-conversion-home-setup.mjs"
export DURE_QA_NAME="Hmux session conversion smoke"
export DURE_QA_ARTIFACT_NAME="hmux-session-conversion"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_PLAN_JSON='[{"label":"main","title":"Dure Hmux session conversion QA","url":"index.html","width":1200,"height":800,"x":-4000,"y":-2000,"visible":true,"focus":false,"focusable":false}]'
exec node "$repo_root/scripts/run-with-build-storage.mjs" qa -- sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
