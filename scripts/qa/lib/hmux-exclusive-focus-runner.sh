#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../../.." &&
    pwd
)
qa_name=${HEBBIAN_QA_NAME:-hmux exclusive OS-focus QA}
wait_seconds=${HEBBIAN_QA_EXCLUSIVE_LOCK_WAIT_SECONDS:-0}
require_execution=${HEBBIAN_QA_REQUIRE_EXECUTION:-0}
runner_pid=$$

case "$wait_seconds" in
  "" | *[!0-9]*)
    echo "$qa_name: HEBBIAN_QA_EXCLUSIVE_LOCK_WAIT_SECONDS must be a non-negative integer" >&2
    exit 2
    ;;
esac
if [ "$wait_seconds" -gt 300 ]; then
  echo "$qa_name: exclusive focus lock wait cannot exceed 300 seconds" >&2
  exit 2
fi

skip_run() {
  reason=$1
  echo "$qa_name: SKIP $reason" >&2
  if [ "$require_execution" = "1" ]; then
    exit 22
  fi
  exit 0
}

run_preflight() {
  set +e
  decision=$(node "$repo_root/scripts/qa/lib/exclusive-focus-preflight.mjs")
  preflight_status=$?
  set -e
  case "$preflight_status" in
    0)
      printf '%s\n' "$decision"
      ;;
    20)
      skip_run "$decision"
      ;;
    *)
      echo "$qa_name: exclusive focus preflight failed: $decision" >&2
      exit "$preflight_status"
      ;;
  esac
}

run_preflight >/dev/null

user_id=$(id -u)
lock_base=${TMPDIR:-/tmp}
case "$lock_base" in
  /*) ;;
  *)
    echo "$qa_name: TMPDIR must be absolute for the machine-global focus lock" >&2
    exit 2
    ;;
esac
lock_root="${lock_base%/}/hebbian-qa-locks-$user_id"
if [ -L "$lock_root" ]; then
  echo "$qa_name: exclusive focus lock directory cannot be a symlink" >&2
  exit 2
fi
mkdir -p "$lock_root"
chmod 700 "$lock_root"
lock_file=${HEBBIAN_QA_EXCLUSIVE_LOCK_FILE:-"$lock_root/hmux-exclusive-os-focus.lock"}
case "$lock_file" in
  /*) ;;
  *)
    echo "$qa_name: exclusive focus lock path must be absolute" >&2
    exit 2
    ;;
esac

holder_root=$(mktemp -d "${lock_base%/}/hebbian-focus-holder.XXXXXX")
holder_ready="$holder_root/ready"
holder_stop="$holder_root/stop"
lock_holder_pid=

cleanup_lock_holder() {
  trap - EXIT HUP INT TERM
  if [ -n "$lock_holder_pid" ]; then
    : >"$holder_stop"
    wait "$lock_holder_pid" 2>/dev/null || true
  fi
  rm -rf "$holder_root"
}
trap cleanup_lock_holder EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Only the holder owns the lock descriptor. The QA app and its detached Hmux
# Host never inherit it, so an orphaned process cannot pin OS-focus admission.
lockf -s -t "$wait_seconds" "$lock_file" /bin/sh -c '
  umask 077
  : >"$1"
  while kill -0 "$3" 2>/dev/null && [ ! -f "$2" ]; do
    sleep 0.05
  done
' hmux-focus-holder "$holder_ready" "$holder_stop" "$runner_pid" &
lock_holder_pid=$!

while [ ! -f "$holder_ready" ]; do
  if ! kill -0 "$lock_holder_pid" 2>/dev/null; then
    set +e
    wait "$lock_holder_pid"
    lock_status=$?
    set -e
    lock_holder_pid=
    case "$lock_status" in
      75)
        skip_run '{"action":"skip","reason":"exclusive_lock_busy"}'
        ;;
      *)
        echo "$qa_name: failed to acquire exclusive focus lock (exit $lock_status)" >&2
        exit "$lock_status"
        ;;
    esac
  fi
  sleep 0.02
done

# Input can arrive while waiting for another QA process. Re-check immediately
# after acquiring the machine-global lock. The app runner performs a third
# check after its hidden app is ready, immediately before creating QA windows.
run_preflight >/dev/null

if [ "${HEBBIAN_QA_EXCLUSIVE_PREFLIGHT_ONLY:-}" = "1" ]; then
  echo "$qa_name: RUN {\"action\":\"run\",\"reason\":\"preflight_only\"}"
  exit 0
fi

set +e
sh "$repo_root/scripts/qa/lib/hmux-window-focus-runner.sh"
qa_status=$?
set -e
exit "$qa_status"
