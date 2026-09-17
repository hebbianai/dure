#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_CLIENT="$repo_root/scripts/qa/ssh-registration-client.mjs"
export DURE_QA_HOME_SETUP="$repo_root/scripts/qa/ssh-registration-home-setup.mjs"
export DURE_QA_NAME="Dure SSH registration native smoke"
export DURE_QA_ARTIFACT_NAME="ssh-registration"
export DURE_QA_LAYER=background
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_WINDOW_PLAN_JSON='[{"label":"main","title":"Dure SSH registration QA","url":"index.html?qaSshRegistration=1","width":1100,"height":700,"x":-4000,"y":-2000,"visible":true,"focus":false,"focusable":false}]'
VITE_DURE_SSH_REGISTRATION_QA_RUN_ID=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
export VITE_DURE_SSH_REGISTRATION_QA_RUN_ID
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
