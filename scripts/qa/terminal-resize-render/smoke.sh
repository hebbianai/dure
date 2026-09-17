#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../../.." &&
    pwd
)
provider=${DURE_QA_TERMINAL_PROVIDER:?DURE_QA_TERMINAL_PROVIDER is required}
case "$provider" in
  *[!a-z0-9_]* | _* | [0-9]* | '')
    echo "DURE_QA_TERMINAL_PROVIDER must be a lowercase provider token" >&2
    exit 2
    ;;
  *)
    if [ "${#provider}" -gt 24 ]; then
      echo "DURE_QA_TERMINAL_PROVIDER must not exceed 24 characters" >&2
      exit 2
    fi
    ;;
esac

export DURE_QA_CLIENT="scripts/qa/terminal-resize-render/client.mjs"
export DURE_QA_ARTIFACT_NAME="terminal-resize-render-$provider"
export DURE_QA_NAME="terminal resize render ($provider)"
export DURE_QA_LAYER="exclusive_focus_terminal_resize_render"
export DURE_QA_WINDOW_TITLE="Dure terminal resize QA ($provider)"
exec sh "$repo_root/scripts/qa/lib/hmux-exclusive-focus-runner.sh"
