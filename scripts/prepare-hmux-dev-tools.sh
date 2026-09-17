#!/bin/sh
set -eu

hmux_prepare_script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
hmux_dev_build_id=${HMUX_DEV_BUILD_ID:-}
hmux_base_target_directory=${CARGO_TARGET_DIR:-hmux/target}
hmux_dev_target_directory="$hmux_base_target_directory/agent-tools/$hmux_dev_build_id"
hmux_dev_channel=${HMUX_DEV_CHANNEL:-}

if ! printf '%s\n' "$hmux_dev_build_id" |
  grep -Eq '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$'; then
  echo "hmux-tools:prepare requires an exact development Hmux build ID" >&2
  exit 1
fi
if ! printf '%s\n' "$hmux_dev_channel" |
  grep -Eq '^dev-[a-z0-9-]{1,60}$'; then
  echo "hmux-tools:prepare requires an isolated development app channel" >&2
  exit 1
fi
if [ -z "${HOME:-}" ]; then
  echo "hmux-tools:prepare requires HOME" >&2
  exit 1
fi

mkdir -p "$hmux_dev_target_directory"
hmux_dev_stage_artifact_directory=$(mktemp -d "$hmux_dev_target_directory/.stage.XXXXXX")
cleanup_hmux_dev_stage() {
  case "${hmux_dev_stage_artifact_directory:-}" in
    "$hmux_dev_target_directory"/.stage.*)
      rm -rf -- "$hmux_dev_stage_artifact_directory"
      ;;
    "") ;;
    *)
      echo "refusing to clean an unexpected Hmux stage directory" >&2
      ;;
  esac
}
trap cleanup_hmux_dev_stage EXIT
trap 'exit 1' HUP INT TERM

HMUX_BUILD_ID="$hmux_dev_build_id" \
  HMUX_DEV_CHANNEL="$hmux_dev_channel" \
  HMUX_SKIP_TAURI_STAGE=1 \
  HMUX_STAGE_ARTIFACT_DIR="$hmux_dev_stage_artifact_directory" \
  "${DURE_POSIX_SHELL:-sh}" "$hmux_prepare_script_directory/stage-hmux-runtime.sh" debug
