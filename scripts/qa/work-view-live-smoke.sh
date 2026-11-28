#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
# A real Claude Code agent works through a multi-step turn against a local
# stand-in for the Messages API; its key reaches nothing else.
port=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')
unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
export ANTHROPIC_BASE_URL="http://127.0.0.1:$port"
export ANTHROPIC_API_KEY="qa-no-real-provider-access"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_AUTOUPDATER=1
export DURE_QA_WORK_VIEW_LIVE_API_PORT="$port"
export DURE_QA_WORK_VIEW_LIVE_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/work-view-live-client.mjs"
export DURE_QA_HOME_SETUP="scripts/qa/work-view-live-home-setup.mjs"
export DURE_QA_NAME="Work view follows a working agent's transcript in WKWebView"
export DURE_QA_ARTIFACT_NAME="work-view-live"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaWorkViewLive=$DURE_QA_WORK_VIEW_LIVE_PROOF"
export DURE_QA_WINDOW_PLAN_JSON="[{\"label\":\"main\",\"title\":\"Dure Work View Live QA\",\"url\":\"$DURE_QA_WINDOW_URL\",\"width\":1280,\"height\":820,\"x\":-4000,\"y\":-2000,\"visible\":true,\"focus\":false,\"focusable\":false}]"
exec node "$repo_root/scripts/run-with-build-storage.mjs" qa -- sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
