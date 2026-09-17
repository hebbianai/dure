#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd -P)
cd "$repo_root"
export CARGO_TARGET_DIR="$repo_root/src-tauri/target"

# Keep the source dev runtime immutable while the release build stages its own
# bundled sidecars. This is generated build input; the app runner owns QA data.
mkdir -p "$repo_root/src-tauri/target"
runtime_inputs=$(mktemp -d "$repo_root/src-tauri/target/worktree-release-qa.XXXXXX")
HMUX_STAGE_ARTIFACT_DIR="$runtime_inputs" pnpm hmux:runtime:stage:dev
export DURE_QA_HMUX_CLI="$runtime_inputs/hmux"
export DURE_QA_HMUX_RUNTIME="$runtime_inputs/hmux-runtime"
export HEBBIAN_DEV_INSTANCE="qa-$(printf '%s' "${runtime_inputs##*.}" | tr '[:upper:]' '[:lower:]')"
DURE_QA_APP_CHANNEL=$(node --input-type=module -e '
  import { worktreeDevIdentity } from "./scripts/lib/app-channel.mjs";
  process.stdout.write(worktreeDevIdentity(process.cwd(), process.env.HEBBIAN_DEV_INSTANCE).channel);
')
export DURE_QA_APP_CHANNEL
export DURE_GHOSTTY_VT_CACHE_ROOT="${DURE_GHOSTTY_VT_CACHE_ROOT:-$HOME/Library/Caches/Dure/ghostty-vt}"
export DURE_QA_CLIENT="$repo_root/scripts/qa/worktree-release-client.mjs"
export DURE_QA_HOME_SETUP="$repo_root/scripts/qa/worktree-release-app.mjs"
export DURE_QA_NAME="Dure worktree release migration"
export DURE_QA_ARTIFACT_NAME="worktree-release"
export DURE_QA_LAYER=background
export DURE_QA_WINDOW_PLAN_JSON='[{"label":"main","title":"Dure worktree release QA","url":"index.html","width":1100,"height":700,"x":-4000,"y":-2000,"visible":true,"focus":false,"focusable":false}]'
exec sh "$repo_root/scripts/qa/lib/tauri-app-runner.sh"
