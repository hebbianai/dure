#!/bin/sh
set -eu

prepare_script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

hmux_dev_build_id=$(node scripts/hmux-dev-build-id.mjs)
hmux_dev_channel=$(node scripts/resolve-dev-app-channel.mjs)
if ! printf '%s\n' "$hmux_dev_channel" |
  grep -Eq '^dev-[a-z0-9-]{1,60}$'; then
  echo "agent-tools:prepare requires an isolated development app channel" >&2
  exit 1
fi
if [ -z "${HOME:-}" ]; then
  echo "agent-tools:prepare requires HOME" >&2
  exit 1
fi

if node "$prepare_script_directory/dev-agent-tools-current.mjs" "$hmux_dev_channel" "$hmux_dev_build_id"; then
  echo "Development agent tools are ready; reusing the verified channel bundle."
  exit 0
fi
echo "Preparing development agent tools for $hmux_dev_channel..."

dure_cli_source_revision=
unset DURE_CLI_SOURCE_REVISION
dure_cli_worktree_state=$(
  git -C "$prepare_script_directory/.." status --porcelain --untracked-files=all
)
if [ -z "$dure_cli_worktree_state" ]; then
  dure_cli_source_revision=$(git -C "$prepare_script_directory/.." rev-parse --verify HEAD)
  export DURE_CLI_SOURCE_REVISION=$dure_cli_source_revision
fi
if [ -n "$dure_cli_source_revision" ] && ! printf '%s\n' "$dure_cli_source_revision" |
  grep -Eq '^([0-9a-f]{40}|[0-9a-f]{64})$'; then
  echo "agent-tools:prepare requires an exact Git source revision" >&2
  exit 1
fi

hmux_dev_install_root="$HOME/.local/share/hmux/channels/$hmux_dev_channel"
hmux_dev_command_directory="$hmux_dev_install_root/bin"
dure_dev_install_root="$HOME/.local/share/hebbian-ide-cli/channels/$hmux_dev_channel"
dure_dev_command_directory="$dure_dev_install_root/bin"

HMUX_DEV_BUILD_ID="$hmux_dev_build_id" \
  HMUX_DEV_CHANNEL="$hmux_dev_channel" \
  "${DURE_POSIX_SHELL:-sh}" "$prepare_script_directory/prepare-hmux-dev-tools.sh"

DURE_CLI_INSTALL_ROOT="$dure_dev_install_root" \
  DURE_CLI_INSTALL_DIR="$dure_dev_command_directory" \
  DURE_APP_CHANNEL="$hmux_dev_channel" \
  DURE_HMUX_BIN="$hmux_dev_command_directory/hmux" \
  DURE_HMUX_RUNTIME_BIN="$hmux_dev_command_directory/hmux-runtime" \
  DURE_HMUX_BUILD_ID="$hmux_dev_build_id" \
  DURE_CLI_LOCK_WAIT_MS="${DURE_CLI_LOCK_WAIT_MS:-${HEBBIAN_IDE_CLI_LOCK_WAIT_MS:-15000}}" \
  node scripts/install-dure-cli.mjs --development

if ! node "$prepare_script_directory/dev-agent-tools-current.mjs" "$hmux_dev_channel" "$hmux_dev_build_id" --verify; then
  echo "Development agent tools are not ready after preparation; app launch was not admitted." >&2
  exit 1
fi
