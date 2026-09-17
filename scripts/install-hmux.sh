#!/bin/sh
set -eu

hmux_install_root=${HMUX_INSTALL_ROOT:-${HOME}/.local/share/hmux}
hmux_command_directory=${HMUX_INSTALL_DIR:-${HOME}/.local/bin}
hmux_prebuilt_directory=${HMUX_PREBUILT_DIR:-}
hmux_lock_wait_seconds=${HMUX_INSTALL_LOCK_WAIT_SECONDS:-0}
hmux_expected_digest=${HMUX_EXPECTED_DIGEST:-}

# One flag, and it exists so that the distributor and the target run the *same*
# implementation of the digest. Provisioning pins a value by running this on the
# tree it is about to send and re-runs it on the tree that arrived; if the two
# sides each had their own copy of the algorithm, a drift between them would
# read as a corrupted transfer and the real defect would be invisible.
hmux_print_digest_only=0
case "${1:-}" in
  --print-prebuilt-digest)
    hmux_print_digest_only=1
    ;;
  "") ;;
  *)
    echo "usage: install-hmux.sh [--print-prebuilt-digest]" >&2
    exit 1
    ;;
esac

# Fail closed on a machine with no digest tool. The tempting alternative — skip
# verification when nothing can compute it — is worse than not verifying at all,
# because the caller still counts the host as verified and the honest failure is
# replaced by a silent one.
hmux_sha256_command=
if command -v sha256sum >/dev/null 2>&1; then
  hmux_sha256_command=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  hmux_sha256_command=shasum
elif command -v openssl >/dev/null 2>&1; then
  hmux_sha256_command=openssl
fi

# Everything hashes from stdin: the file name never reaches the tool, so no
# path needs quoting and no tool's argument parsing can be surprised by one.
hmux_sha256_of_stream() {
  case "$hmux_sha256_command" in
    sha256sum) sha256sum | cut -d ' ' -f 1 ;;
    shasum) shasum -a 256 | cut -d ' ' -f 1 ;;
    openssl) openssl dgst -sha256 | sed -n 's/^.*= *//; /^[0-9a-f][0-9a-f]*$/p' ;;
  esac
}

# The digest covers exactly the three files an install consumes — the two
# binaries and the manifest that names them — in a fixed order. Fixed order and
# per-file hashing rather than hashing an archive: the value has to be
# reproducible from an *unpacked* tree on the far side, where tar framing,
# mtimes, uid/gid, and `find` ordering are all gone.
#
# What this establishes: the bytes that arrived are the bytes that were sent,
# and the tree filed under a build id is the tree that was pinned. It is
# integrity against corruption and truncation, and a stable name for a build.
#
# What it does NOT establish: origin. The expected value travels the same ssh
# channel as the bytes it describes, so whoever can substitute the artifact can
# substitute the pin in the same breath. Signing the digests and publishing them
# somewhere the artifact does not travel is separate work that is not done.
#
# What it also does not cover: any other file sitting in the tree. That is
# deliberate — the installer copies these three and nothing else, so a fourth
# file never becomes runnable, and widening the digest would make it disagree
# with what is actually installed.
hmux_prebuilt_tree_digest() {
  hmux_digest_tree=$1
  hmux_digest_suffix=$2
  if [ -z "$hmux_sha256_command" ]; then
    echo "no SHA-256 tool (sha256sum, shasum, or openssl) is available" >&2
    exit 1
  fi
  hmux_digest_manifest=
  for hmux_digest_member in \
    install.json \
    "bin/hmux$hmux_digest_suffix" \
    "bin/hmux-runtime$hmux_digest_suffix"; do
    hmux_digest_file="$hmux_digest_tree/$hmux_digest_member"
    if [ ! -f "$hmux_digest_file" ]; then
      echo "Hmux tree is missing $hmux_digest_member: $hmux_digest_tree" >&2
      exit 1
    fi
    hmux_digest_manifest="$hmux_digest_manifest$(
      hmux_sha256_of_stream <"$hmux_digest_file"
    )  $hmux_digest_member
"
  done
  hmux_digest_value=$(printf '%s' "$hmux_digest_manifest" | hmux_sha256_of_stream)
  # A tool that is on PATH but broken — a stub, a wrapper that lost its
  # dependency, a busybox applet compiled out — returns success with nothing on
  # stdout. Without this the empty result would flow onward as a digest and the
  # operator would be told the artifact was corrupted, which sends them looking
  # at the wrong machine.
  if ! printf '%s\n' "$hmux_digest_value" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "the SHA-256 tool ($hmux_sha256_command) produced no usable digest" >&2
    exit 1
  fi
  printf '%s\n' "$hmux_digest_value"
}

if [ -n "$hmux_expected_digest" ] || [ "$hmux_print_digest_only" = 1 ]; then
  if [ -z "$hmux_prebuilt_directory" ]; then
    echo "digest verification requires HMUX_PREBUILT_DIR" >&2
    exit 1
  fi
fi
# A malformed pin must not be treated as "no pin". Refuse anything that is not
# one lowercase SHA-256 hex value, so a truncated or prefixed pin fails loudly
# instead of comparing unequal against every possible tree.
if [ -n "$hmux_expected_digest" ] &&
  ! printf '%s\n' "$hmux_expected_digest" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "HMUX_EXPECTED_DIGEST must be one lowercase SHA-256 hex digest" >&2
  exit 1
fi

# This script must keep working on a machine that has only itself and an
# unpacked artifact: no repository, no git, no Rust toolchain. That is the
# whole reason Linux artifacts exist. So everything the source path derives
# from the checkout (package version from hmux/Cargo.toml, triple from rustc,
# build id from git) has to come from the artifact instead — and it must come
# from *inside* the tree, not from the tarball's file name, because a rename
# would otherwise make the install lie about what it installed.
read_hmux_prebuilt_field() {
  hmux_prebuilt_field=$1
  sed -n "s/^  \"$hmux_prebuilt_field\": \"\\(.*\\)\",\$/\\1/p" \
    "$hmux_prebuilt_manifest" | head -n 1
}

if [ -n "$hmux_prebuilt_directory" ]; then
  if [ -n "${HMUX_ARTIFACT_DIR:-}" ]; then
    echo "HMUX_PREBUILT_DIR and HMUX_ARTIFACT_DIR both name a binary source" >&2
    exit 1
  fi
  hmux_prebuilt_manifest="$hmux_prebuilt_directory/install.json"
  if [ ! -d "$hmux_prebuilt_directory" ] || [ ! -f "$hmux_prebuilt_manifest" ]; then
    echo "HMUX_PREBUILT_DIR must contain install.json: $hmux_prebuilt_directory" >&2
    exit 1
  fi
  if ! grep -Fqx '  "schemaVersion": 1,' "$hmux_prebuilt_manifest"; then
    echo "unsupported Hmux prebuilt manifest schema: $hmux_prebuilt_manifest" >&2
    exit 1
  fi
  hmux_target_triple=$(read_hmux_prebuilt_field targetTriple)
  hmux_package_version=$(read_hmux_prebuilt_field packageVersion)
  hmux_profile=$(read_hmux_prebuilt_field profile)
  hmux_prebuilt_build_id=$(read_hmux_prebuilt_field buildId)
  if [ -z "$hmux_target_triple" ] || [ -z "$hmux_package_version" ] ||
    [ -z "$hmux_profile" ] || [ -z "$hmux_prebuilt_build_id" ]; then
    echo "prebuilt Hmux manifest is missing required fields: $hmux_prebuilt_manifest" >&2
    exit 1
  fi
else
  hmux_target_triple=${CARGO_BUILD_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}
  hmux_package_version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' hmux/Cargo.toml | head -n 1)
  hmux_profile=${HMUX_PROFILE:-release}
fi

if [ -z "$hmux_install_root" ] || [ -z "$hmux_command_directory" ]; then
  echo "HMUX_INSTALL_ROOT and HMUX_INSTALL_DIR must not be empty" >&2
  exit 1
fi
if [ -z "$hmux_target_triple" ] || [ -z "$hmux_package_version" ]; then
  echo "could not determine the Hmux target triple or package version" >&2
  exit 1
fi
# install.json is written by a shell heredoc, so an unchecked value carrying a
# quote or a newline would emit a manifest that no longer parses — and the
# immutability check below is a literal grep against that manifest.
if ! printf '%s\n' "$hmux_package_version" |
  grep -Eq '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'; then
  echo "the Hmux package version contains unsafe characters" >&2
  exit 1
fi
case "$hmux_profile" in
  debug) hmux_cargo_profile_args= ;;
  release) hmux_cargo_profile_args=--release ;;
  *)
    echo "HMUX_PROFILE must be debug or release" >&2
    exit 1
    ;;
esac
if ! printf '%s\n' "$hmux_lock_wait_seconds" | grep -Eq '^[0-9]+$' ||
  [ "$hmux_lock_wait_seconds" -gt 60 ]; then
  echo "HMUX_INSTALL_LOCK_WAIT_SECONDS must be an integer from 0 through 60" >&2
  exit 1
fi
if ! printf '%s\n' "$hmux_target_triple" |
  grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'; then
  echo "the Hmux target triple contains unsafe characters" >&2
  exit 1
fi

hmux_suffix=
case "$hmux_target_triple" in
  *-windows-*) hmux_suffix=.exe ;;
esac

# Verified before anything is concluded from the tree. Every check below this
# point — architecture, operating system, build-id agreement — reads values out
# of the same manifest the digest covers, so checking the bytes first is what
# makes those checks mean anything. It is also well before the version
# directory is created and long before `current` moves, which is the property
# that matters: a tree that fails here never becomes runnable.
if [ "$hmux_print_digest_only" = 1 ]; then
  hmux_prebuilt_tree_digest "$hmux_prebuilt_directory" "$hmux_suffix" || exit 1
  exit 0
fi
if [ -n "$hmux_expected_digest" ]; then
  hmux_actual_digest=$(
    hmux_prebuilt_tree_digest "$hmux_prebuilt_directory" "$hmux_suffix"
  ) || exit 1
  if [ "$hmux_actual_digest" != "$hmux_expected_digest" ]; then
    echo "Hmux artifact digest does not match the pinned value" >&2
    echo "  expected: $hmux_expected_digest" >&2
    echo "  actual:   $hmux_actual_digest" >&2
    echo "  tree:     $hmux_prebuilt_directory" >&2
    exit 1
  fi
fi

# A source build's triple is whatever this toolchain just produced, so it
# cannot be wrong. A prebuilt tree can be: nothing in the copy path notices
# an ELF for another machine, and the failure surfaces at exec time — after
# `current` has already been swung away from the install that worked.
# Compare only when both sides are recognized, so an unfamiliar triple is
# refused by an incomplete table rather than by evidence.
if [ -n "$hmux_prebuilt_directory" ]; then
  hmux_host_machine=unknown
  case "$(uname -m)" in
    x86_64 | amd64) hmux_host_machine=x86_64 ;;
    aarch64 | arm64) hmux_host_machine=aarch64 ;;
  esac
  hmux_artifact_machine=unknown
  case "$hmux_target_triple" in
    x86_64-*) hmux_artifact_machine=x86_64 ;;
    aarch64-*) hmux_artifact_machine=aarch64 ;;
  esac
  if [ "$hmux_host_machine" != unknown ] &&
    [ "$hmux_artifact_machine" != unknown ] &&
    [ "$hmux_host_machine" != "$hmux_artifact_machine" ]; then
    echo "prebuilt Hmux targets $hmux_artifact_machine, this machine is $hmux_host_machine" >&2
    exit 1
  fi

  hmux_host_system=unknown
  case "$(uname -s)" in
    Linux) hmux_host_system=linux ;;
    Darwin) hmux_host_system=darwin ;;
  esac
  hmux_artifact_system=unknown
  case "$hmux_target_triple" in
    *-linux-*) hmux_artifact_system=linux ;;
    *-apple-darwin) hmux_artifact_system=darwin ;;
  esac
  if [ "$hmux_host_system" != unknown ] &&
    [ "$hmux_artifact_system" != unknown ] &&
    [ "$hmux_host_system" != "$hmux_artifact_system" ]; then
    echo "prebuilt Hmux targets $hmux_artifact_system, this machine runs $hmux_host_system" >&2
    exit 1
  fi
fi

if [ -n "$hmux_prebuilt_directory" ]; then
  # The build id is the immutability key: two different trees under one id is
  # exactly the corruption the versions directory exists to prevent. So an
  # override may confirm the artifact's own id, never silently rename it.
  hmux_build_id=$hmux_prebuilt_build_id
  if [ -n "${HMUX_BUILD_ID:-}" ] && [ "$HMUX_BUILD_ID" != "$hmux_build_id" ]; then
    echo "HMUX_BUILD_ID disagrees with the prebuilt manifest build id" >&2
    exit 1
  fi
elif [ -n "${HMUX_BUILD_ID:-}" ]; then
  hmux_build_id=$HMUX_BUILD_ID
else
  hmux_revision=$(git rev-parse --short=12 HEAD)
  if [ -n "$(
    git status --porcelain --untracked-files=normal -- \
      hmux crates/hebbian-process-sampler
  )" ]; then
    echo "refusing to install a dirty Hmux build without an explicit HMUX_BUILD_ID" >&2
    exit 1
  fi
  hmux_build_id="${hmux_package_version}+${hmux_revision}"
fi

if ! printf '%s\n' "$hmux_build_id" |
  grep -Eq '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$'; then
  echo "HMUX_BUILD_ID must be one safe path component (letters, digits, . _ + -)" >&2
  exit 1
fi

if [ -z "$hmux_prebuilt_directory" ] && [ "${HMUX_SKIP_BUILD:-0}" != "1" ]; then
  HMUX_BUILD_ID="$hmux_build_id" \
    "${DURE_POSIX_SHELL:-sh}" scripts/build-hmux-product-runtime.sh "$hmux_target_triple" \
      cargo build --locked \
      --manifest-path hmux/Cargo.toml \
      $hmux_cargo_profile_args \
      --package hmux-cli \
      --package hmux-runtime
fi

if [ -n "$hmux_prebuilt_directory" ]; then
  # A prebuilt tree is laid out exactly like an installed version directory,
  # so the copy below is the same code path as a source install.
  hmux_artifact_directory="$hmux_prebuilt_directory/bin"
elif [ -n "${HMUX_ARTIFACT_DIR:-}" ]; then
  hmux_artifact_directory=$HMUX_ARTIFACT_DIR
else
  hmux_target_root=${CARGO_TARGET_DIR:-hmux/target}
  if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
    hmux_target_root="$hmux_target_root/$hmux_target_triple"
  fi
  hmux_artifact_directory="$hmux_target_root/$hmux_profile"
fi

hmux_cli_source="$hmux_artifact_directory/hmux${hmux_suffix}"
hmux_runtime_source="$hmux_artifact_directory/hmux-runtime${hmux_suffix}"
for hmux_source in "$hmux_cli_source" "$hmux_runtime_source"; do
  if [ ! -f "$hmux_source" ] || [ ! -x "$hmux_source" ]; then
    echo "Hmux install artifact is missing or not executable: $hmux_source" >&2
    exit 1
  fi
done

# Every product surface is structured-only. A source build carries the feature
# by construction, but the two explicit reuse paths can name any executable.
# Ask the exact binary that would be installed so a feature-dark runtime never
# becomes current merely because its file name and mode look right. Keep this
# check self-contained: prebuilt hosts receive this installer, not the checkout.
hmux_runtime_build_info=$(
  "$hmux_runtime_source" --no-autostart hmux-build-info
) || {
  echo "Hmux product runtime did not report build information: $hmux_runtime_source" >&2
  exit 1
}
printf '%s\n' "$hmux_runtime_build_info" |
  grep -Fq '"productProfile":"structured-terminal-v1"' || {
  echo "Hmux runtime is not the structured product profile: $hmux_runtime_source" >&2
  exit 1
}

hmux_versions_directory="$hmux_install_root/versions"
hmux_version_directory="$hmux_versions_directory/$hmux_build_id"
mkdir -p "$hmux_versions_directory" "$hmux_command_directory"
hmux_install_root=$(CDPATH= cd -- "$hmux_install_root" && pwd -P)
hmux_command_directory=$(CDPATH= cd -- "$hmux_command_directory" && pwd -P)
hmux_versions_directory="$hmux_install_root/versions"
hmux_version_directory="$hmux_versions_directory/$hmux_build_id"

chmod go-w "$hmux_install_root"
if [ -L "$hmux_versions_directory" ] || [ ! -d "$hmux_versions_directory" ]; then
  echo "refusing unsafe Hmux versions directory" >&2
  exit 1
fi
# The desktop app will execute the version-pinned CLI for pairing. A permissive
# caller umask must not make either lookup directory replaceable by another
# group member after installation. Harden parent-to-child so each descendant
# is no longer replaceable before it is inspected or repaired.
chmod go-w "$hmux_versions_directory"

hmux_mutation_lock="$hmux_install_root/.mutation-lock"
hmux_lock_wait_ticks=$((hmux_lock_wait_seconds * 10))
hmux_lock_waited_ticks=0
while ! mkdir "$hmux_mutation_lock" 2>/dev/null; do
  if [ "$hmux_lock_waited_ticks" -ge "$hmux_lock_wait_ticks" ]; then
    echo "another Hmux install or prune operation holds $hmux_mutation_lock" >&2
    exit 1
  fi
  sleep 0.1
  hmux_lock_waited_ticks=$((hmux_lock_waited_ticks + 1))
done
hmux_staging_directory=
cleanup_hmux_install() {
  if [ -n "${hmux_staging_directory:-}" ] && [ -d "$hmux_staging_directory" ]; then
    rm -rf "$hmux_staging_directory"
  fi
  rmdir "$hmux_mutation_lock" 2>/dev/null || true
}
trap cleanup_hmux_install EXIT
trap 'exit 1' HUP INT TERM

validate_hmux_version_tree() {
  hmux_tree=$1
  hmux_tree_bin="$hmux_tree/bin"
  if [ -L "$hmux_tree" ] || [ ! -d "$hmux_tree" ] ||
    [ -L "$hmux_tree_bin" ] || [ ! -d "$hmux_tree_bin" ]; then
    echo "refusing unsafe immutable Hmux build $hmux_build_id" >&2
    exit 1
  fi
  for hmux_tree_file in \
    "$hmux_tree/install.json" \
    "$hmux_tree_bin/hmux${hmux_suffix}" \
    "$hmux_tree_bin/hmux-runtime${hmux_suffix}"; do
    if [ -L "$hmux_tree_file" ] || [ ! -f "$hmux_tree_file" ] ||
      [ "$(find "$hmux_tree_file" -prune -type f -links 1 -print)" != "$hmux_tree_file" ] ||
      [ -n "$(find "$hmux_tree_file" -prune -type f -perm -020 -print)" ] ||
      [ -n "$(find "$hmux_tree_file" -prune -type f -perm -002 -print)" ]; then
      echo "refusing unsafe immutable Hmux build $hmux_build_id" >&2
      exit 1
    fi
  done
}

harden_hmux_version_directories() {
  hmux_tree=$1
  hmux_tree_bin="$hmux_tree/bin"
  if [ -L "$hmux_tree" ] || [ ! -d "$hmux_tree" ]; then
    echo "refusing unsafe immutable Hmux build $hmux_build_id" >&2
    exit 1
  fi
  chmod go-w "$hmux_tree"
  if [ -L "$hmux_tree_bin" ] || [ ! -d "$hmux_tree_bin" ]; then
    echo "refusing unsafe immutable Hmux build $hmux_build_id" >&2
    exit 1
  fi
  chmod go-w "$hmux_tree_bin"
}

harden_hmux_staging_files() {
  hmux_tree=$1
  chmod 644 "$hmux_tree/install.json"
  chmod 755 \
    "$hmux_tree/bin/hmux${hmux_suffix}" \
    "$hmux_tree/bin/hmux-runtime${hmux_suffix}"
}

if [ -e "$hmux_version_directory" ] || [ -L "$hmux_version_directory" ]; then
  harden_hmux_version_directories "$hmux_version_directory"
  validate_hmux_version_tree "$hmux_version_directory"
  if ! cmp -s "$hmux_cli_source" "$hmux_version_directory/bin/hmux${hmux_suffix}" ||
    ! cmp -s "$hmux_runtime_source" "$hmux_version_directory/bin/hmux-runtime${hmux_suffix}" ||
    [ ! -x "$hmux_version_directory/bin/hmux${hmux_suffix}" ] ||
    [ ! -x "$hmux_version_directory/bin/hmux-runtime${hmux_suffix}" ] ||
    ! grep -Fqx "  \"buildId\": \"$hmux_build_id\"," "$hmux_version_directory/install.json"; then
    echo "refusing to replace immutable Hmux build $hmux_build_id" >&2
    exit 1
  fi
  # Older installs may have inherited writable lookup directories from the
  # caller umask. Only directories are repaired parent-to-child above: a
  # writable file may retain an adversary-held descriptor, so files fail closed.
else
  hmux_staging_directory=$(mktemp -d "$hmux_install_root/.install.XXXXXX")

  mkdir -p "$hmux_staging_directory/bin"
  install -m 755 "$hmux_cli_source" "$hmux_staging_directory/bin/hmux${hmux_suffix}"
  install -m 755 \
    "$hmux_runtime_source" \
    "$hmux_staging_directory/bin/hmux-runtime${hmux_suffix}"
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
  harden_hmux_staging_files "$hmux_staging_directory"
  validate_hmux_version_tree "$hmux_staging_directory"
  harden_hmux_version_directories "$hmux_staging_directory"
  mv "$hmux_staging_directory" "$hmux_version_directory"
  hmux_staging_directory=
fi

atomic_symlink() {
  hmux_link_target=$1
  hmux_link_path=$2
  hmux_link_parent=$(dirname "$hmux_link_path")
  hmux_link_temporary="$hmux_link_parent/.hmux-link-$$"
  if [ -d "$hmux_link_path" ] && [ ! -L "$hmux_link_path" ]; then
    echo "refusing to replace directory with Hmux symlink: $hmux_link_path" >&2
    exit 1
  fi
  rm -f "$hmux_link_temporary"
  ln -s "$hmux_link_target" "$hmux_link_temporary"
  case "$(uname -s)" in
    Darwin | FreeBSD | NetBSD | OpenBSD)
      mv -fh "$hmux_link_temporary" "$hmux_link_path"
      ;;
    *)
      mv -fT "$hmux_link_temporary" "$hmux_link_path"
      ;;
  esac
}

preserve_pre_versioned_command() {
  hmux_existing_command=$1
  hmux_command_name=$2
  if [ ! -e "$hmux_existing_command" ] || [ -L "$hmux_existing_command" ]; then
    return
  fi
  if [ ! -f "$hmux_existing_command" ] || [ ! -x "$hmux_existing_command" ]; then
    echo "refusing to replace non-executable Hmux command: $hmux_existing_command" >&2
    exit 1
  fi
  hmux_rollback_directory="$hmux_install_root/rollback/pre-versioned/bin"
  hmux_rollback_command="$hmux_rollback_directory/$hmux_command_name"
  if [ -L "$hmux_install_root/rollback" ]; then
    echo "refusing unsafe Hmux rollback directory" >&2
    exit 1
  fi
  mkdir -p "$hmux_rollback_directory"
  if [ ! -e "$hmux_rollback_command" ]; then
    install -m 755 "$hmux_existing_command" "$hmux_rollback_command"
    echo "Preserved previous command at $hmux_rollback_command"
  fi
}

preserve_pre_versioned_command \
  "$hmux_command_directory/hmux${hmux_suffix}" \
  "hmux${hmux_suffix}"
preserve_pre_versioned_command \
  "$hmux_command_directory/hmux-runtime${hmux_suffix}" \
  "hmux-runtime${hmux_suffix}"

atomic_symlink "versions/$hmux_build_id" "$hmux_install_root/current"
atomic_symlink \
  "$hmux_install_root/current/bin/hmux${hmux_suffix}" \
  "$hmux_command_directory/hmux${hmux_suffix}"
atomic_symlink \
  "$hmux_install_root/current/bin/hmux-runtime${hmux_suffix}" \
  "$hmux_command_directory/hmux-runtime${hmux_suffix}"

echo "Installed immutable Hmux build $hmux_build_id"
echo "  version: $hmux_version_directory"
echo "  current: $hmux_install_root/current"
echo "  command: $hmux_command_directory/hmux${hmux_suffix}"
cleanup_hmux_install
trap - EXIT HUP INT TERM
