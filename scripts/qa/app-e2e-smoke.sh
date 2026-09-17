#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)

export HEBBIAN_QA_CLIENT="scripts/qa/app-control-smoke-client.mjs"
export HEBBIAN_QA_NAME="HebbianIDE app E2E smoke"
export HEBBIAN_QA_ARTIFACT_NAME="app-e2e"
export HEBBIAN_QA_WINDOW_TITLE="HebbianIDE App E2E"
export HEBBIAN_QA_WINDOW_URL="index.html"
export HEBBIAN_QA_PROVIDER_BIN="$repo_root/scripts/qa/fake-provider"
export HEBBIAN_QA_LAYER="control_plane"
export PATH="$HEBBIAN_QA_PROVIDER_BIN:$PATH"
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
