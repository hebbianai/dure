#!/bin/sh
set -eu

# Lays a built Hmux out as an unpacked *version directory* — bin/ plus
# install.json — which is exactly the shape `scripts/install-hmux.sh` installs
# with HMUX_PREBUILT_DIR. Identity travels inside the tree rather than in the
# tarball's file name so that renaming or re-uploading an artifact cannot make
# the install claim a provenance it does not have.
#
# usage: sh scripts/package-hmux-prebuilt.sh <target-triple> <output-directory>
#   HMUX_BUILD_ID    required; the immutability key the install is filed under
#   HMUX_PROFILE     debug|release (default release)
#   HMUX_ARTIFACT_DIR  overrides where the two binaries are read from

fail() {
  echo "package hmux prebuilt: $*" >&2
  exit 1
}

hmux_target_triple=${1:-}
hmux_output_directory=${2:-}
hmux_build_id=${HMUX_BUILD_ID:-}
hmux_profile=${HMUX_PROFILE:-release}
hmux_package_script_directory=$(
  CDPATH= cd -- "$(dirname -- "$0")" && pwd -P
)

[ -n "$hmux_target_triple" ] && [ -n "$hmux_output_directory" ] ||
  fail "usage: $0 <target-triple> <output-directory>"
[ -n "$hmux_build_id" ] || fail "HMUX_BUILD_ID is required"
case "$hmux_profile" in
  debug | release) ;;
  *) fail "HMUX_PROFILE must be debug or release" ;;
esac
printf '%s\n' "$hmux_target_triple" |
  grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' ||
  fail "the target triple contains unsafe characters"
printf '%s\n' "$hmux_build_id" |
  grep -Eq '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$' ||
  fail "HMUX_BUILD_ID must be one safe path component"

hmux_package_version=$(
  sed -n 's/^version = "\([^"]*\)"/\1/p' hmux/Cargo.toml | head -n 1
)
[ -n "$hmux_package_version" ] || fail "could not read the Hmux package version"

hmux_suffix=
case "$hmux_target_triple" in
  *-windows-*) hmux_suffix=.exe ;;
esac

if [ -n "${HMUX_ARTIFACT_DIR:-}" ]; then
  hmux_artifact_directory=$HMUX_ARTIFACT_DIR
else
  hmux_artifact_directory="${CARGO_TARGET_DIR:-hmux/target}/$hmux_target_triple/$hmux_profile"
fi

hmux_staging_directory=
cleanup_hmux_package() {
  if [ -n "$hmux_staging_directory" ] && [ -d "$hmux_staging_directory" ]; then
    rm -rf "$hmux_staging_directory"
  fi
}
trap cleanup_hmux_package EXIT
trap 'exit 1' HUP INT TERM

[ ! -e "$hmux_output_directory" ] ||
  fail "output directory already exists: $hmux_output_directory"
mkdir -p "$(dirname "$hmux_output_directory")"
hmux_staging_directory=$(
  mktemp -d "$(dirname "$hmux_output_directory")/.package.XXXXXX"
)
mkdir "$hmux_staging_directory/bin"
chmod 755 "$hmux_staging_directory" "$hmux_staging_directory/bin"

for hmux_command in hmux hmux-runtime; do
  hmux_source="$hmux_artifact_directory/$hmux_command$hmux_suffix"
  [ -f "$hmux_source" ] && [ -x "$hmux_source" ] ||
    fail "build artifact is missing or not executable: $hmux_source"
  case "$hmux_target_triple" in
    *-linux-*)
      sh "$hmux_package_script_directory/verify-static-linux-binary.sh" \
        "$hmux_target_triple" "$hmux_source"
      ;;
  esac
  install -m 755 "$hmux_source" "$hmux_staging_directory/bin/$hmux_command$hmux_suffix"
done

# Cross-built Linux binaries cannot run on the macOS release builder. The
# compiled marker is a fail-closed packaging boundary; native installation
# additionally executes hmux-build-info from the exact copied runtime.
sh scripts/verify-hmux-product-runtime.sh \
  marker "$hmux_staging_directory/bin/hmux-runtime$hmux_suffix"

# Byte-identical to the manifest scripts/install-hmux.sh writes, because that
# script re-reads these fields with a line-anchored sed and then re-emits the
# same layout for its immutability grep. `pnpm test` pins the round trip.
cat >"$hmux_staging_directory/install.json" <<EOF
{
  "schemaVersion": 1,
  "buildId": "$hmux_build_id",
  "packageVersion": "$hmux_package_version",
  "profile": "$hmux_profile",
  "targetTriple": "$hmux_target_triple",
  "protocol": { "minimum": "1.0", "maximum": "1.0" }
}
EOF
chmod 644 "$hmux_staging_directory/install.json"

mv "$hmux_staging_directory" "$hmux_output_directory"
hmux_staging_directory=

echo "Packaged Hmux $hmux_build_id for $hmux_target_triple"
echo "  tree: $hmux_output_directory"
cleanup_hmux_package
trap - EXIT HUP INT TERM
