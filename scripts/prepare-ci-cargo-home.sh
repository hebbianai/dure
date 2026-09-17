#!/bin/sh
set -eu

fail() {
  echo "ci cargo isolation: $*" >&2
  exit 1
}

[ "${GITHUB_ACTIONS:-}" = "true" ] ||
  fail "this script may run only inside GitHub Actions"

runner_temp=${HEBBIAN_CI_RUNNER_TEMP:-}
cargo_home=${CARGO_HOME:-}
github_env=${GITHUB_ENV:-}

[ -n "$runner_temp" ] || fail "HEBBIAN_CI_RUNNER_TEMP is required"
[ -n "$cargo_home" ] || fail "CARGO_HOME is required"
[ -n "$github_env" ] || fail "GITHUB_ENV is required"

case "$runner_temp" in
  /) fail "runner temp cannot be the filesystem root" ;;
  /*) runner_temp=${runner_temp%/} ;;
  *) fail "runner temp must be absolute" ;;
esac

expected_cargo_home="$runner_temp/hebbian-cargo-home"
[ "$cargo_home" = "$expected_cargo_home" ] ||
  fail "expected exact runner-owned CARGO_HOME $expected_cargo_home"
[ -d "$runner_temp" ] || fail "runner temp does not exist"
[ ! -L "$cargo_home" ] || fail "CARGO_HOME must not be a symlink"
[ -f "$github_env" ] || fail "GITHUB_ENV must be an existing regular file"
[ ! -L "$github_env" ] || fail "GITHUB_ENV must not be a symlink"

if [ -e "$cargo_home" ] && [ ! -d "$cargo_home" ]; then
  fail "CARGO_HOME exists but is not a directory"
fi

umask 077
mkdir -p "$cargo_home"
chmod 700 "$cargo_home"

runner_temp_real=$(cd "$runner_temp" && pwd -P)
cargo_home_real=$(cd "$cargo_home" && pwd -P)
github_env_dir_real=$(cd "$(dirname "$github_env")" && pwd -P)
case "$cargo_home_real" in
  "$runner_temp_real"/*) ;;
  *) fail "CARGO_HOME resolves outside runner temp" ;;
esac
case "$github_env_dir_real" in
  "$runner_temp_real"/*) ;;
  *) fail "GITHUB_ENV resolves outside runner temp" ;;
esac

if [ -n "${HOME:-}" ] && [ "$cargo_home_real" = "$HOME/.cargo" ]; then
  fail "CARGO_HOME resolves to developer state"
fi

printf '%s:%s:%s\n' \
  "${GITHUB_RUN_ID:-unknown}" \
  "${GITHUB_RUN_ATTEMPT:-unknown}" \
  "${GITHUB_JOB:-unknown}" \
  >"$cargo_home/.hebbian-ci-owner"

printf 'CARGO_HOME=%s\n' "$cargo_home_real" >>"$github_env"

echo "Cargo home isolated under runner temp"
