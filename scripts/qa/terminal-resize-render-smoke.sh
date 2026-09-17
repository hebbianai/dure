#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
exec node "$repo_root/scripts/qa/terminal-resize-render/run.mjs" "$@"
