#!/bin/sh
set -eu

fail() {
  echo "ci cargo target: $*" >&2
  exit 1
}

file_mtime() {
  if stat -f '%m' "$1" >/dev/null 2>&1; then
    stat -f '%m' "$1"
  else
    stat -c '%Y' "$1"
  fi
}

validate_positive_integer() {
  value=$1
  label=$2
  minimum=$3
  maximum=$4
  case "$value" in
    '' | *[!0-9]*) fail "$label must be an integer" ;;
  esac
  [ "$value" -ge "$minimum" ] || fail "$label must be at least $minimum"
  [ "$value" -le "$maximum" ] || fail "$label must be at most $maximum"
}

ensure_private_directory() {
  directory=$1
  label=$2
  [ ! -L "$directory" ] || fail "$label must not be a symlink"
  if [ -e "$directory" ]; then
    [ -d "$directory" ] || fail "$label exists but is not a directory"
  else
    mkdir "$directory"
  fi
  chmod 700 "$directory"
}

validate_root_marker() {
  marker=$target_root/.hebbian-ci-target-root
  [ -f "$marker" ] || fail "target root is missing its ownership marker"
  [ ! -L "$marker" ] || fail "target root marker must not be a symlink"
  [ "$(cat "$marker")" = "hebbian-ci-target-root-v1" ] ||
    fail "target root ownership marker is invalid"
}

expected_generation_marker() {
  generation_hash=$1
  printf 'format=1\nprofile=%s\nrust=%s\n' "$profile" "$generation_hash"
}

validate_generation() {
  generation=$1
  generation_name=$(basename "$generation")
  printf '%s\n' "$generation_name" | grep -Eq '^[0-9a-f]{16}$' || return 1
  [ -d "$generation" ] || return 1
  [ ! -L "$generation" ] || return 1
  generation_marker=$generation/.hebbian-ci-target-owner
  [ -f "$generation_marker" ] || return 1
  [ ! -L "$generation_marker" ] || return 1
  [ "$(cat "$generation_marker")" = "$(expected_generation_marker "$generation_name")" ]
}

remove_generation() {
  generation=$1
  reason=$2
  validate_generation "$generation" ||
    fail "refusing to remove an unmanaged Cargo target generation: $generation"
  generation_real=$(cd "$generation" && pwd -P)
  case "$generation_real" in
    "$profile_real"/[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) fail "Cargo target generation resolved outside its owned profile" ;;
  esac
  echo "$reason: $generation_real"
  rm -rf "$generation_real"
}

generation_count() {
  count=0
  for candidate in "$profile_dir"/*; do
    [ -e "$candidate" ] || continue
    validate_generation "$candidate" ||
      fail "unrecognized entry in Cargo target profile: $candidate"
    count=$((count + 1))
  done
  printf '%s\n' "$count"
}

oldest_inactive_generation() {
  oldest_path=
  oldest_mtime=
  for candidate in "$profile_dir"/*; do
    [ -e "$candidate" ] || continue
    validate_generation "$candidate" ||
      fail "unrecognized entry in Cargo target profile: $candidate"
    [ "$candidate" != "$target_dir" ] || continue
    candidate_mtime=$(file_mtime "$candidate")
    if [ -z "$oldest_path" ] || [ "$candidate_mtime" -lt "$oldest_mtime" ]; then
      oldest_path=$candidate
      oldest_mtime=$candidate_mtime
    fi
  done
  printf '%s\n' "$oldest_path"
}

mode=${1:-}
case "$mode" in
  prepare | release) ;;
  *) fail "usage: $0 prepare|release" ;;
esac

[ "${GITHUB_ACTIONS:-}" = "true" ] ||
  fail "this script may run only inside GitHub Actions"

runner_temp=${HEBBIAN_CI_RUNNER_TEMP:-}
workspace=${GITHUB_WORKSPACE:-}
profile=${HEBBIAN_CI_TARGET_PROFILE:-}
run_id=${GITHUB_RUN_ID:-}
run_attempt=${GITHUB_RUN_ATTEMPT:-}
job=${GITHUB_JOB:-}

[ -n "$runner_temp" ] || fail "HEBBIAN_CI_RUNNER_TEMP is required"
[ -n "$workspace" ] || fail "GITHUB_WORKSPACE is required"
case "$profile" in
  verify | windows-cross-target | linux-musl-artifacts | hmux-release-trust | hmux-release-promotion) ;;
  *) fail "HEBBIAN_CI_TARGET_PROFILE is not an allowed profile" ;;
esac
case "$run_id" in
  '' | *[!0-9]*) fail "GITHUB_RUN_ID must be numeric" ;;
esac
case "$run_attempt" in
  '' | *[!0-9]*) fail "GITHUB_RUN_ATTEMPT must be numeric" ;;
esac
case "$job" in
  '' | *[!A-Za-z0-9_.-]*) fail "GITHUB_JOB must be one safe token" ;;
esac

case "$runner_temp" in
  /) fail "runner temp cannot be the filesystem root" ;;
  /*) ;;
  *) fail "runner temp must be absolute" ;;
esac
[ -d "$runner_temp" ] || fail "runner temp does not exist"
[ -d "$workspace" ] || fail "GitHub workspace does not exist"

runner_temp_real=$(cd "$runner_temp" && pwd -P)
runner_work_real=$(dirname "$runner_temp_real")
[ "$runner_work_real" != "/" ] || fail "runner work root cannot be filesystem root"
workspace_real=$(cd "$workspace" && pwd -P)
case "$workspace_real" in
  "$runner_work_real"/*) ;;
  *) fail "GitHub workspace is outside the runner work root" ;;
esac

target_root=$runner_work_real/_hebbian-ci-targets-v1
profile_dir=$target_root/$profile
lease_dir=$profile_dir/.lease
lease_marker=$lease_dir/.hebbian-ci-lease
expected_lease_owner=$run_id:$run_attempt:$job

if [ "$mode" = release ]; then
  [ -e "$target_root" ] || exit 0
  [ ! -L "$target_root" ] || fail "target root must not be a symlink"
  [ -d "$target_root" ] || fail "target root is not a directory"
  validate_root_marker
  [ -e "$profile_dir" ] || exit 0
  [ ! -L "$profile_dir" ] || fail "target profile must not be a symlink"
  [ -d "$profile_dir" ] || fail "target profile is not a directory"
  [ -e "$lease_dir" ] || exit 0
  [ ! -L "$lease_dir" ] || fail "target lease must not be a symlink"
  [ -d "$lease_dir" ] || fail "target lease is not a directory"
  [ -f "$lease_marker" ] || fail "target lease has no ownership marker"
  [ ! -L "$lease_marker" ] || fail "target lease marker must not be a symlink"
  actual_lease_owner=$(cat "$lease_marker")
  [ "$actual_lease_owner" = "$expected_lease_owner" ] ||
    fail "target lease belongs to another run: $actual_lease_owner"
  rm "$lease_marker"
  rmdir "$lease_dir"
  echo "Released runner-local Cargo target lease"
  exit 0
fi

github_env=${GITHUB_ENV:-}
[ -n "$github_env" ] || fail "GITHUB_ENV is required"
[ -f "$github_env" ] || fail "GITHUB_ENV must be an existing regular file"
[ ! -L "$github_env" ] || fail "GITHUB_ENV must not be a symlink"
github_env_dir_real=$(cd "$(dirname "$github_env")" && pwd -P)
case "$github_env_dir_real" in
  "$runner_temp_real"/*) ;;
  *) fail "GITHUB_ENV resolves outside runner temp" ;;
esac

max_kib=${HEBBIAN_CI_TARGET_MAX_KIB:-12582912}
stale_lease_seconds=${HEBBIAN_CI_TARGET_STALE_LEASE_SECONDS:-2100}
retention_seconds=${HEBBIAN_CI_TARGET_RETENTION_SECONDS:-1209600}
validate_positive_integer "$max_kib" "target disk cap KiB" 64 104857600
validate_positive_integer \
  "$stale_lease_seconds" \
  "stale target lease seconds" \
  60 \
  86400
validate_positive_integer \
  "$retention_seconds" \
  "target retention seconds" \
  3600 \
  7776000

[ ! -L "$target_root" ] || fail "target root must not be a symlink"
if [ -e "$target_root" ]; then
  [ -d "$target_root" ] || fail "target root exists but is not a directory"
  validate_root_marker
else
  mkdir "$target_root"
  chmod 700 "$target_root"
  printf 'hebbian-ci-target-root-v1\n' >"$target_root/.hebbian-ci-target-root"
fi
target_root_real=$(cd "$target_root" && pwd -P)
case "$target_root_real" in
  "$runner_work_real"/*) ;;
  *) fail "target root resolves outside runner work root" ;;
esac
case "$target_root_real" in
  "$workspace_real" | "$workspace_real"/*)
    fail "target root must stay outside the GitHub checkout"
    ;;
esac
case "$target_root_real" in
  "$runner_temp_real" | "$runner_temp_real"/*)
    fail "target root must stay outside runner temp"
    ;;
esac

ensure_private_directory "$profile_dir" "target profile"
profile_real=$(cd "$profile_dir" && pwd -P)
case "$profile_real" in
  "$target_root_real"/"$profile") ;;
  *) fail "target profile resolves outside its owned root" ;;
esac

if [ -e "$lease_dir" ]; then
  [ ! -L "$lease_dir" ] || fail "target lease must not be a symlink"
  [ -d "$lease_dir" ] || fail "target lease exists but is not a directory"
  [ -f "$lease_marker" ] || fail "target lease has no ownership marker"
  [ ! -L "$lease_marker" ] || fail "target lease marker must not be a symlink"
  lease_owner=$(cat "$lease_marker")
  lease_mtime=$(file_mtime "$lease_dir")
  now=$(date +%s)
  lease_age=$((now - lease_mtime))
  if [ "$lease_age" -lt "$stale_lease_seconds" ]; then
    fail "active target lease belongs to $lease_owner"
  fi
  rm "$lease_marker"
  rmdir "$lease_dir" ||
    fail "stale target lease contains unexpected files"
  echo "Reclaimed stale Cargo target lease from $lease_owner"
fi

mkdir "$lease_dir" || fail "could not acquire target lease"
chmod 700 "$lease_dir"
printf '%s\n' "$expected_lease_owner" >"$lease_marker"
keep_lease=0
release_failed_prepare() {
  if [ "$keep_lease" -eq 0 ] &&
    [ -f "$lease_marker" ] &&
    [ "$(cat "$lease_marker")" = "$expected_lease_owner" ]; then
    rm "$lease_marker"
    rmdir "$lease_dir" 2>/dev/null || true
  fi
}
trap release_failed_prepare 0 1 2 3 15

rust_description=$(rustc -vV) || fail "rustc -vV failed"
[ -n "$rust_description" ] || fail "rustc -vV returned no identity"
rust_hash=$(printf '%s\n' "$rust_description" | shasum -a 256 | awk '{print substr($1, 1, 16)}')
printf '%s\n' "$rust_hash" | grep -Eq '^[0-9a-f]{16}$' ||
  fail "could not hash the Rust toolchain identity"

target_dir=$profile_dir/$rust_hash
if [ -e "$target_dir" ]; then
  validate_generation "$target_dir" ||
    fail "current Cargo target generation is not owned by this workflow"
else
  mkdir "$target_dir"
  chmod 700 "$target_dir"
  expected_generation_marker "$rust_hash" >"$target_dir/.hebbian-ci-target-owner"
fi
touch "$target_dir"

now=$(date +%s)
for candidate in "$profile_dir"/*; do
  [ -e "$candidate" ] || continue
  validate_generation "$candidate" ||
    fail "unrecognized entry in Cargo target profile: $candidate"
  [ "$candidate" != "$target_dir" ] || continue
  candidate_mtime=$(file_mtime "$candidate")
  candidate_age=$((now - candidate_mtime))
  if [ "$candidate_age" -ge "$retention_seconds" ]; then
    remove_generation "$candidate" "Removed expired Cargo target generation"
  fi
done

while [ "$(generation_count)" -gt 2 ]; do
  oldest=$(oldest_inactive_generation)
  [ -n "$oldest" ] ||
    fail "could not select an inactive Cargo target generation"
  remove_generation "$oldest" "Removed excess Cargo target generation"
done

profile_kib=$(du -sk "$profile_dir" | awk '{print $1}')
while [ "$profile_kib" -gt "$max_kib" ]; do
  oldest=$(oldest_inactive_generation)
  if [ -n "$oldest" ]; then
    remove_generation "$oldest" "Removed Cargo target generation above disk cap"
  else
    remove_generation "$target_dir" "Reset oversized Cargo target generation"
    mkdir "$target_dir"
    chmod 700 "$target_dir"
    expected_generation_marker "$rust_hash" >"$target_dir/.hebbian-ci-target-owner"
  fi
  profile_kib=$(du -sk "$profile_dir" | awk '{print $1}')
done

target_real=$(cd "$target_dir" && pwd -P)
case "$target_real" in
  "$profile_real"/"$rust_hash") ;;
  *) fail "Cargo target resolves outside its owned profile" ;;
esac

# Tauri recognizes bare Cargo executables only below a literal target directory.
# Keep generation ownership and retention outside that native output boundary.
cargo_target_dir=$target_real/target
ensure_private_directory "$cargo_target_dir" "Cargo output directory"
cargo_target_real=$(cd "$cargo_target_dir" && pwd -P)
[ "$cargo_target_real" = "$target_real/target" ] ||
  fail "Cargo output directory resolves outside its owned generation"

printf 'CARGO_TARGET_DIR=%s\n' "$cargo_target_real" >>"$github_env"
printf 'HEBBIAN_CI_TARGET_ROOT=%s\n' "$target_root_real" >>"$github_env"
keep_lease=1
trap - 0 1 2 3 15

profile_kib=$(du -sk "$profile_dir" | awk '{print $1}')
echo "Cargo target prepared outside checkout: $cargo_target_real (${profile_kib} KiB profile)"
