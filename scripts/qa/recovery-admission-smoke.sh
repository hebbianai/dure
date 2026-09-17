#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export DURE_QA_RECOVERY_PROOF=$(uuidgen | tr '[:upper:]' '[:lower:]')
export DURE_QA_CLIENT="scripts/qa/recovery-admission-client.mjs"
# Reuse the bounded, account-free provider and cooperative completion channel.
export DURE_QA_HOME_SETUP="scripts/qa/managed-successor-adoption-home-setup.mjs"
export DURE_QA_NAME="recovery admission"
export DURE_QA_ARTIFACT_NAME="recovery-admission"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export SHELL=/bin/zsh
export DURE_QA_WINDOW_URL="index.html?qaWindowSmokeController=1&qaRecoveryAdmission=$DURE_QA_RECOVERY_PROOF&qaRecoveryDetail=${DURE_QA_RECOVERY_DETAIL:-0}&qaRecoveryExit=${DURE_QA_RECOVERY_EXIT:-0}&qaRecoveryHealthReturn=${DURE_QA_RECOVERY_HEALTH_RETURN:-0}"
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
