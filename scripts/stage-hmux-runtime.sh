#!/bin/sh
set -eu

hmux_stage_script_directory=$(
  CDPATH= cd -- "$(dirname -- "$0")" && pwd -P
)

hmux_profile=${1:-debug}
hmux_dev_channel=${HMUX_DEV_CHANNEL:-}
case "$hmux_profile" in
  debug)
    hmux_cargo_profile_args=
    hmux_cargo_packages="--package hmux-cli --package hmux-runtime"
    hmux_build_id=${HMUX_BUILD_ID:-$(node scripts/hmux-dev-build-id.mjs)}
    ;;
  release)
    hmux_cargo_profile_args=--release
    hmux_cargo_packages="--package hmux-cli --package hmux-runtime"
    hmux_build_id=${HMUX_BUILD_ID:-}
    ;;
  *)
    echo "usage: $0 [debug|release]" >&2
    exit 2
    ;;
esac

hmux_base_target_root=${CARGO_TARGET_DIR:-hmux/target}
if [ "$hmux_profile" = debug ]; then
  if ! printf '%s\n' "$hmux_build_id" |
    grep -Eq '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$'; then
    echo "HMUX_BUILD_ID must be one safe path component (letters, digits, . _ + -)" >&2
    exit 1
  fi
  hmux_target_root="$hmux_base_target_root/agent-tools/$hmux_build_id"
  # Keep final runtime generations separate, but let Cargo reuse and lock
  # intermediates across source revisions within this target root.
  CARGO_BUILD_BUILD_DIR=${CARGO_BUILD_BUILD_DIR:-"$hmux_base_target_root/agent-tools-build"}
  export CARGO_BUILD_BUILD_DIR
else
  hmux_target_root=$hmux_base_target_root
fi
hmux_build_target_root=$hmux_target_root

hmux_target_triple=${CARGO_BUILD_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}
if [ -z "$hmux_target_triple" ]; then
  echo "could not determine the Rust target triple" >&2
  exit 1
fi

HMUX_BUILD_ID="$hmux_build_id" \
  CARGO_TARGET_DIR="$hmux_target_root" \
  "${DURE_POSIX_SHELL:-sh}" "$hmux_stage_script_directory/build-hmux-product-runtime.sh" "$hmux_target_triple" \
    cargo build \
    --locked \
    --manifest-path hmux/Cargo.toml \
    $hmux_cargo_packages \
    $hmux_cargo_profile_args

if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  hmux_target_root="$hmux_target_root/$hmux_target_triple"
fi

hmux_suffix=
case "$hmux_target_triple" in
  *-windows-*) hmux_suffix=.exe ;;
esac
hmux_built_artifact_directory="$hmux_target_root/$hmux_profile"
hmux_stage_artifact_directory=${HMUX_STAGE_ARTIFACT_DIR:-}
hmux_skip_tauri_stage=${HMUX_SKIP_TAURI_STAGE:-0}
case "$hmux_skip_tauri_stage" in
  0 | 1) ;;
  *)
    echo "HMUX_SKIP_TAURI_STAGE must be 0 or 1" >&2
    exit 2
    ;;
esac
hmux_owned_stage_artifact_directory=
hmux_tauri_staging_file=
cleanup_hmux_stage() {
  if [ -n "${hmux_tauri_staging_file:-}" ]; then
    rm -f -- "$hmux_tauri_staging_file"
  fi
  if [ -n "${hmux_owned_stage_artifact_directory:-}" ]; then
    rm -rf -- "$hmux_owned_stage_artifact_directory"
  fi
}
trap cleanup_hmux_stage EXIT
trap 'exit 1' HUP INT TERM

if [ -n "$hmux_stage_artifact_directory" ]; then
  if [ -L "$hmux_stage_artifact_directory" ] ||
    [ ! -d "$hmux_stage_artifact_directory" ]; then
    echo "HMUX_STAGE_ARTIFACT_DIR must be an existing non-symlink directory" >&2
    exit 1
  fi
else
  hmux_stage_artifact_directory=$(mktemp -d "${TMPDIR:-/tmp}/dure-hmux-stage.XXXXXX")
  hmux_owned_stage_artifact_directory=$hmux_stage_artifact_directory
fi

for hmux_binary in hmux-runtime hmux; do
  hmux_source="$hmux_built_artifact_directory/${hmux_binary}${hmux_suffix}"
  hmux_private_artifact="$hmux_stage_artifact_directory/${hmux_binary}${hmux_suffix}"
  if [ -e "$hmux_private_artifact" ] || [ -L "$hmux_private_artifact" ]; then
    echo "refusing to replace an existing private Hmux stage artifact: $hmux_private_artifact" >&2
    exit 1
  fi
  cp "$hmux_source" "$hmux_private_artifact"
  chmod 755 "$hmux_private_artifact"
done

# Rust's macOS debug linker records randomized temporary `.rcgu.o` names in
# debug symbols. Normalize private copies so a signal or concurrent stage can
# never leave Cargo's fingerprint-valid output unsigned or partially changed.
if [ "$hmux_profile" = debug ]; then
  case "$hmux_target_triple" in
    *-apple-darwin)
      if [ "$(/usr/bin/uname -s)" != Darwin ]; then
        echo "cannot normalize a macOS Hmux dev build on a non-macOS host" >&2
        exit 1
      fi
      for hmux_binary in hmux-runtime hmux; do
        hmux_private_artifact="$hmux_stage_artifact_directory/${hmux_binary}${hmux_suffix}"
        /usr/bin/strip -S "$hmux_private_artifact"
        /usr/bin/codesign --force --sign - "$hmux_private_artifact"
      done
      ;;
  esac
fi

"${DURE_POSIX_SHELL:-sh}" "$hmux_stage_script_directory/verify-hmux-product-runtime.sh" \
  execute "$hmux_stage_artifact_directory/hmux-runtime$hmux_suffix"

if [ -n "$hmux_dev_channel" ]; then
  if ! printf '%s\n' "$hmux_dev_channel" |
    grep -Eq '^dev-[a-z0-9-]{1,60}$'; then
    echo "HMUX_DEV_CHANNEL must identify an isolated development channel" >&2
    exit 1
  fi
  if [ -z "${HOME:-}" ]; then
    echo "HMUX_DEV_CHANNEL activation requires HOME" >&2
    exit 1
  fi
  hmux_dev_install_root="$HOME/.local/share/hmux/channels/$hmux_dev_channel"
  hmux_dev_command_directory="$hmux_dev_install_root/bin"
  CARGO_TARGET_DIR="$hmux_build_target_root" \
    HMUX_ARTIFACT_DIR="$hmux_stage_artifact_directory" \
    HMUX_BUILD_ID="$hmux_build_id" \
    HMUX_INSTALL_DIR="$hmux_dev_command_directory" \
    HMUX_PROFILE="$hmux_profile" \
    HMUX_SKIP_BUILD=1 \
    HMUX_INSTALL_ROOT="$hmux_dev_install_root" \
    HMUX_INSTALL_LOCK_WAIT_SECONDS="${HMUX_INSTALL_LOCK_WAIT_SECONDS:-15}" \
    "${DURE_POSIX_SHELL:-sh}" "$hmux_stage_script_directory/install-hmux.sh"
  node "$hmux_stage_script_directory/verify-hmux-dev-activation.mjs" \
    "$hmux_build_id" \
    "$hmux_dev_install_root/current/bin/hmux$hmux_suffix" \
    "$hmux_dev_install_root/current/bin/hmux-runtime$hmux_suffix"
  printf 'DURE_HMUX_ACTIVATION_V1 %s\n' "$hmux_build_id"
fi

if [ "$hmux_skip_tauri_stage" = 1 ]; then
  exit 0
fi

node "$hmux_stage_script_directory/guard-hmux-app-stage.mjs"
mkdir -p src-tauri/binaries

# 사이드카 둘. `hmux-runtime`은 세션을 띄우고, `hmux`는 설정 화면의 QR 페어링이
# 부른다.
#
# 페어링 규칙을 앱에 다시 구현하는 대신 CLI를 그대로 부르기로 했기 때문에 이
# 바이너리가 필요하다 — 2026-07-29에 같은 규칙을 두 곳에 두었다가 Tailscale
# 호스트에서만 터지는 버그를 겪었고, 그 판단의 대가가 여기 5MB다.
for hmux_binary in hmux-runtime hmux; do
  hmux_source="$hmux_stage_artifact_directory/${hmux_binary}${hmux_suffix}"
  hmux_destination="src-tauri/binaries/${hmux_binary}-${hmux_target_triple}${hmux_suffix}"
  hmux_tauri_staging_file=$(mktemp "src-tauri/binaries/.${hmux_binary}-${hmux_target_triple}.XXXXXX")
  cp "$hmux_source" "$hmux_tauri_staging_file"
  chmod 755 "$hmux_tauri_staging_file"
  mv -f "$hmux_tauri_staging_file" "$hmux_destination"
  hmux_tauri_staging_file=
  echo "Staged $hmux_destination"
done
