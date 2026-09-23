#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_CLIENT="scripts/qa/client-space-create-client.mjs"
export DURE_QA_NAME="CLI and MCP Space creation in WKWebView"
export DURE_QA_ARTIFACT_NAME="client-space-create"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
