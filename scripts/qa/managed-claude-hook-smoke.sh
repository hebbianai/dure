#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
# Keep the runner-owned root short enough for native Unix sockets below its
# disposable HOME/TMPDIR. macOS's default /var/folders prefix exceeds sun_path.
export TMPDIR=/tmp
if [ "${DURE_QA_CLAUDE_CONTINUATION_ONLY:-0}" != 1 ]; then
  export DURE_QA_CLAUDE_BIN=${DURE_QA_CLAUDE_BIN:-$(command -v claude)}
fi
export DURE_QA_CLIENT="scripts/qa/managed-claude-hook-client.mjs"
export DURE_QA_NAME="managed Claude native hook publication"
export DURE_QA_ARTIFACT_NAME="managed-claude-hook"
export DURE_QA_UNIQUE_APP_CHANNEL=1
export DURE_QA_LAYER="background"
export DURE_QA_WINDOW_URL="index.html?qaWindowSmokeController=1"
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
