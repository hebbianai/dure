#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "IME preedit smoke: macOS is required" >&2
  exit 1
fi

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
cd "$repo_root"

cleanup() {
  rm -f "$repo_root/qa.log"
}
trap cleanup EXIT HUP INT TERM
rm -f qa.log

DURE_QA_CLIENT="$repo_root/scripts/qa/ime-preedit-client.mjs" \
DURE_QA_NAME="IME preedit smoke" \
DURE_QA_ARTIFACT_NAME="ime-preedit" \
DURE_QA_LAYER="background" \
DURE_QA_UNIQUE_APP_CHANNEL=1 \
DURE_QA_WINDOW_TITLE="Dure IME Preedit QA" \
DURE_QA_WINDOW_URL="index.html?qaImePreedit=1" \
DURE_QA_WINDOW_PLAN_JSON='[{"label":"ime-preedit","title":"Dure IME Preedit QA","url":"index.html?qaImePreedit=1","width":480,"height":240,"x":-4000,"y":-2000,"visible":true,"focus":false,"focusable":false}]' \
VITE_DURE_IME_PREEDIT_QA=1 \
  sh scripts/qa/lib/tauri-app-runner.sh
