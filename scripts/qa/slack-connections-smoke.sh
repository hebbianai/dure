#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
scenario=${1:-connections}
unset DURE_QA_SLACK_LIVE
case "$scenario" in
  connections) query=qaSlackConnections; preload_name=slack-connector-network ;;
  share|live)
    query=qaSlackShare; preload_name=slack-share-network
    : "${DURE_QA_CODEX_HOME:?Choose the test account home for native sharing QA}"
    export DURE_QA_CODEX_BIN=$(command -v codex)
    if [ "$scenario" = live ]; then
      : "${DURE_QA_SLACK_LIVE_CREDENTIALS:?Choose the private Slack app credential file}"
      : "${DURE_QA_SLACK_TEAM:?Choose the real Slack workspace}"
      : "${DURE_QA_SLACK_CHANNEL:?Choose the authorized Slack test channel}"
      scenario=share
      export DURE_QA_SLACK_LIVE=1
    fi
    ;;
  *) echo "usage: $0 [connections|share|live]" >&2; exit 1 ;;
esac
node scripts/stage-mobile-runtime.mjs
# The connection service is Pro-only; use the development backend built from
# this checkout, then let the existing runner install its complete CLI bundle.
DURE_CONTROL_PLANE_BIN=$(node --input-type=module -e '
  import { cargoArtifact } from "./scripts/qa/managed-provider-fixture.mjs";
  process.stdout.write(await cargoArtifact([
    "build", "--locked", "--manifest-path", "crates/dure-app/Cargo.toml",
    "-p", "dure-control-plane", "--bin", "dure-control-plane",
    "--bin", "dure-claude-process-relay",
  ], "dure-control-plane"));
')
export DURE_CONTROL_PLANE_BIN
export DURE_QA_SLACK_CONNECTIONS_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/slack-$scenario-client.mjs"
export DURE_QA_HOME_SETUP="scripts/qa/slack-connections-home-setup.mjs"
export DURE_QA_NODE_BIN=$(node -p 'process.execPath')
export SHELL=/bin/zsh
export DURE_QA_NAME="native Slack $scenario"
export DURE_QA_ARTIFACT_NAME="slack-$scenario"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?$query=$DURE_QA_SLACK_CONNECTIONS_PROOF"
if [ "${DURE_QA_SLACK_LIVE:-0}" = 1 ]; then
  export DURE_QA_WINDOW_URL="$DURE_QA_WINDOW_URL&slackLive=1"
fi
export DURE_QA_WINDOW_PLAN_JSON="[{\"label\":\"main\",\"title\":\"Dure Slack QA\",\"url\":\"$DURE_QA_WINDOW_URL\",\"width\":1100,\"height\":800,\"x\":-4000,\"y\":-2000,\"visible\":true,\"focus\":false,\"focusable\":false}]"
if [ "${DURE_QA_SLACK_LIVE:-0}" = 1 ]; then
  unset NODE_OPTIONS
else
  preload=$(node --input-type=module -e 'import {pathToFileURL} from "node:url"; process.stdout.write(pathToFileURL(process.argv[1]).href)' "$repo_root/scripts/fixtures/$preload_name.mjs")
  export NODE_OPTIONS="--import=$preload"
fi
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
