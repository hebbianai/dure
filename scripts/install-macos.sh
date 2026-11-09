#!/bin/sh
# Install the current public Dure beta on an Apple silicon Mac:
#
#   curl -fsSL https://raw.githubusercontent.com/hebbianai/dure/main/scripts/install-macos.sh | sh
#
# The DMG must match the digest published with its release, and the app must
# carry Dure's notarized Developer ID signature, before anything is replaced.
# Set DURE_APP_INSTALL_DIR to choose another destination folder.

set -eu

release_repository="hebbianai/dure"
# Installed apps update from this feed, and the publisher advances it only after
# rechecking a release. GitHub's own "latest" release skips prereleases.
feed_url="https://raw.githubusercontent.com/hebbianai/hebbian-releases/main/beta/latest.json"
system_applications_dir="/Applications"
signing_requirement='anchor apple generic and identifier "io.hebbian.ade" and certificate leaf[subject.OU] = "8L5WFHS4F9"'

work_dir=""
mount_point=""
stage_dir=""
app_path=""
previous_app=""

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'Dure install failed: %s\n' "$*" >&2
  exit 1
}

restore_previous_app() {
  if [ -n "$previous_app" ] && [ -e "$previous_app" ] && [ ! -e "$app_path" ]; then
    mv "$previous_app" "$app_path" || :
  fi
}

cleanup() {
  restore_previous_app
  if [ -n "$mount_point" ]; then
    hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 ||
      hdiutil detach "$mount_point" -force -quiet >/dev/null 2>&1 || :
  fi
  if [ -n "$stage_dir" ]; then
    rm -rf "$stage_dir" 2>/dev/null || :
  fi
  if [ -n "$work_dir" ]; then
    rm -rf "$work_dir" 2>/dev/null || :
  fi
}

fetch() {
  curl --disable --fail --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --retry 3 --show-error "$@"
}

json_value() {
  plutil -extract "$2" raw -o - "$1" 2>/dev/null
}

is_apple_silicon() {
  # A shell running under Rosetta reports x86_64 on Apple silicon.
  [ "$(uname -m)" = arm64 ] || [ "$(sysctl -in hw.optional.arm64 2>/dev/null || :)" = 1 ]
}

choose_install_dir() {
  install_dir=${DURE_APP_INSTALL_DIR:-}
  if [ -z "$install_dir" ]; then
    if [ -w "$system_applications_dir" ]; then
      install_dir=$system_applications_dir
    else
      install_dir=$HOME/Applications
    fi
  fi
  case "$install_dir" in
    /*) ;;
    *) die "DURE_APP_INSTALL_DIR must be an absolute path." ;;
  esac
  mkdir -p "$install_dir" || die "could not create $install_dir."
  [ -w "$install_dir" ] || die "cannot write to $install_dir."
  app_path=$install_dir/Dure.app
}

refuse_if_running() {
  # Only the app itself: agent runtimes launched from the bundle may outlive it.
  if ps -axo comm= | grep -Fxq -- "$app_path/Contents/MacOS/dure"; then
    die "Dure is running from $app_path. Quit Dure and run this script again."
  fi
}

read_current_version() {
  fetch --silent --output "$work_dir/feed.json" "$feed_url" ||
    die "could not read the current release from $feed_url."
  version=$(json_value "$work_dir/feed.json" version) ||
    die "the release feed did not name a version."
  case "$version" in
    "" | *[!0-9.]*) die "the release feed named an unexpected version: $version." ;;
  esac
  dmg_name=Dure_${version}_aarch64.dmg
}

read_published_digest() {
  fetch --silent --header 'Accept: application/vnd.github+json' \
    --output "$work_dir/release.json" \
    "https://api.github.com/repos/$release_repository/releases/tags/v$version" ||
    die "could not read the published digest for v$version from GitHub. GitHub limits anonymous requests per hour, so try again later."
  digest=""
  index=0
  while name=$(json_value "$work_dir/release.json" "assets.$index.name"); do
    if [ "$name" = "$dmg_name" ]; then
      digest=$(json_value "$work_dir/release.json" "assets.$index.digest") || digest=""
      break
    fi
    index=$((index + 1))
  done
  digest_hex=${digest#sha256:}
  case "$digest" in
    sha256:*) ;;
    *) die "release v$version publishes no SHA-256 digest for $dmg_name." ;;
  esac
  case "$digest_hex" in
    *[!0-9a-f]*) die "release v$version publishes an invalid digest for $dmg_name." ;;
  esac
  [ "${#digest_hex}" -eq 64 ] ||
    die "release v$version publishes an invalid digest for $dmg_name."
}

download_dmg() {
  dmg=$work_dir/$dmg_name
  if [ -t 2 ]; then
    progress=--progress-bar
  else
    progress=--silent
  fi
  fetch "$progress" --output "$dmg" \
    "https://github.com/$release_repository/releases/download/v$version/$dmg_name" ||
    die "could not download $dmg_name."
  actual=$(shasum -a 256 "$dmg") || die "could not compute the digest of $dmg_name."
  [ "${actual%% *}" = "$digest_hex" ] ||
    die "$dmg_name does not match the digest published with v$version. Nothing was installed."
}

mount_dmg() {
  mount_point=$work_dir/volume
  mkdir "$mount_point"
  hdiutil attach "$dmg" -nobrowse -readonly -noautoopen -quiet -mountpoint "$mount_point" ||
    die "could not open $dmg_name."
  [ -d "$mount_point/Dure.app" ] || die "$dmg_name does not contain Dure.app."
}

stage_app() {
  # A sibling of the destination, so the final move stays on one volume.
  stage_dir=$(mktemp -d "$install_dir/.dure-install.XXXXXX") ||
    die "could not prepare a staging folder in $install_dir."
  ditto "$mount_point/Dure.app" "$stage_dir/Dure.app" ||
    die "could not copy Dure.app into $install_dir."
  # curl leaves no quarantine flag, so Gatekeeper would not check this copy.
  codesign --verify --deep --strict -R="$signing_requirement" "$stage_dir/Dure.app" 2>/dev/null ||
    die "Dure.app is not signed by Dure. Nothing was replaced."
  spctl --assess --type execute "$stage_dir/Dure.app" 2>/dev/null ||
    die "macOS did not accept Dure.app as notarized. Nothing was replaced."
}

replace_app() {
  refuse_if_running
  replace_hint="If macOS blocked this, allow your terminal under System Settings > Privacy & Security > App Management and run the script again."
  if [ -e "$app_path" ]; then
    # Not named .app, so LaunchServices never treats it as a second install.
    mv "$app_path" "$stage_dir/previous" || die "could not replace $app_path. $replace_hint"
    previous_app=$stage_dir/previous
  fi
  if ! mv "$stage_dir/Dure.app" "$app_path"; then
    restore_previous_app
    die "could not install $app_path. $replace_hint"
  fi
}

add_command() {
  cli=$app_path/Contents/Resources/resources/dure-cli/current
  # The app's startup bootstrap refuses to roll back a newer CLI, but only
  # repairs a command that already exists. The app's CLI installer creates it.
  if ! "$cli/bin/node" "$cli/bin/lib/dure-cli-bootstrap.mjs" "$HOME" stable >/dev/null ||
    ! "$cli/bin/dure" install --global >/dev/null; then
    die "Dure is installed at $app_path, but the dure command could not be added. Run this script again to retry."
  fi
}

print_summary() {
  log "Dure $version is installed at $app_path."
  case ":${PATH:-}:" in
    *":$HOME/.local/bin:"*) log "The dure command is ready." ;;
    *)
      log "The dure command is in ~/.local/bin, which is not on your PATH yet. Add this line to ~/.zprofile:"
      # shellcheck disable=SC2016 # The line is for the user's profile.
      log '  export PATH="$HOME/.local/bin:$PATH"'
      ;;
  esac
}

main() {
  [ "$(uname -s)" = Darwin ] || die "this script installs Dure on macOS only."
  is_apple_silicon || die "the Dure Mac beta requires Apple silicon."
  [ "$(id -u)" -ne 0 ] || die "run this script without sudo. Dure installs for your own account."
  [ -n "${HOME:-}" ] || die "HOME is not set."

  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  choose_install_dir
  refuse_if_running
  work_dir=$(mktemp -d "${TMPDIR:-/tmp}/dure-install.XXXXXX") ||
    die "could not create a temporary folder."
  read_current_version
  read_published_digest
  log "Downloading Dure $version..."
  download_dmg
  mount_dmg
  stage_app
  replace_app
  add_command
  print_summary
}

# Nothing runs until the whole script has arrived. Child commands must not read
# the rest of a piped script from standard input.
main "$@" </dev/null
