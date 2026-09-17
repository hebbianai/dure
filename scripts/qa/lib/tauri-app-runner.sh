#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "${DURE_QA_NAME:-${HEBBIAN_QA_NAME:-Dure app QA}}: macOS is required" >&2
  exit 1
fi

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../../.." &&
    pwd
)
cd "$repo_root"

qa_client=${DURE_QA_CLIENT:-${HEBBIAN_QA_CLIENT:-}}
: "${qa_client:?DURE_QA_CLIENT is required}"
qa_home_setup=${DURE_QA_HOME_SETUP:-${HEBBIAN_QA_HOME_SETUP:-}}
qa_name=${DURE_QA_NAME:-${HEBBIAN_QA_NAME:-Dure app QA}}
artifact_name=${DURE_QA_ARTIFACT_NAME:-${HEBBIAN_QA_ARTIFACT_NAME:-tauri-app}}
artifact_root=${DURE_QA_ARTIFACT_ROOT:-${HEBBIAN_QA_ARTIFACT_ROOT:-"$repo_root/artifacts/qa"}}
window_title=${DURE_QA_WINDOW_TITLE:-${HEBBIAN_QA_WINDOW_TITLE:-Dure QA}}
window_url=${DURE_QA_WINDOW_URL:-${HEBBIAN_QA_WINDOW_URL:-index.html}}
qa_layer=${DURE_QA_LAYER:-${HEBBIAN_QA_LAYER:-exclusive_focus}}
failure_class=runner_preflight
runner_cancel_file=${DURE_QA_RUNNER_CANCEL_FILE:-${HEBBIAN_QA_RUNNER_CANCEL_FILE:-}}
runner_timeout_seconds=${DURE_QA_RUNNER_TIMEOUT_SECONDS:-${HEBBIAN_QA_RUNNER_TIMEOUT_SECONDS:-}}
runner_completion_receipt=${DURE_QA_RUNNER_COMPLETION_RECEIPT:-${HEBBIAN_QA_RUNNER_COMPLETION_RECEIPT:-}}
unset \
  DURE_QA_RUNNER_CANCEL_FILE \
  DURE_QA_RUNNER_TIMEOUT_SECONDS \
  DURE_QA_RUNNER_COMPLETION_RECEIPT \
  HEBBIAN_QA_RUNNER_CANCEL_FILE \
  HEBBIAN_QA_RUNNER_TIMEOUT_SECONDS \
  HEBBIAN_QA_RUNNER_COMPLETION_RECEIPT

case "$artifact_name" in
  "" | *[!a-z0-9._-]*)
    echo "DURE_QA_ARTIFACT_NAME must be a lowercase filesystem-safe name" >&2
    exit 1
    ;;
esac
case "$qa_layer" in
  "" | *[!a-z0-9_]*)
    echo "DURE_QA_LAYER must be a lowercase QA token" >&2
    exit 1
    ;;
esac

started_at_ms=$(node -e 'process.stdout.write(String(Date.now()))')
commit_sha=$(git rev-parse HEAD)
tree_sha=$(git rev-parse 'HEAD^{tree}')
dirty=false
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  dirty=true
fi

state_root=$(mktemp -d "${TMPDIR:-/tmp}/dure-${artifact_name}.XXXXXX")
# Hmux receipts identify the physical discovery namespace. Export one spelling
# before deriving any child roots, including on macOS where /var is a symlink.
state_root=$(CDPATH= cd -- "$state_root" && pwd -P)
qa_webview_data_store_identifier=$(
  node -e '
    const { createHash } = require("node:crypto");
    process.stdout.write(createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 32));
  ' "$state_root"
)
qa_app_channel=$(node --input-type=module -e '
  import { validateAppChannel } from "./scripts/lib/app-channel.mjs";
  process.stdout.write(validateAppChannel(process.env.DURE_QA_APP_CHANNEL ?? "stable"));
')
if [ -z "${DURE_QA_APP_CHANNEL:-}" ] && [ "${DURE_QA_UNIQUE_APP_CHANNEL:-0}" = "1" ]; then
  qa_channel_suffix=$(basename "$state_root" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | tail -c 17)
  qa_app_channel="qa-${qa_channel_suffix:-isolated}"
fi
qa_home="$state_root/home"
qa_discovery="$state_root/hmux-discovery"
qa_hmux_install="$state_root/hmux-install"
qa_capture="$state_root/provider-capture"
app_log="$state_root/tauri-dev.log"
client_log="$state_root/client.log"
client_pipe="$state_root/client.pipe"
evidence_source="$state_root/evidence"
monitor_stop="$state_root/monitor.stop"
background_focus_violation="$state_root/background-focus-violation"
background_focus_observation_failure="$state_root/background-focus-observation-failure"
exclusive_input_request="$state_root/exclusive-input.request"
exclusive_input_ack="$state_root/exclusive-input.ack"
process_group_runner="$repo_root/scripts/qa/lib/owned-process-group.mjs"
launch_owner_guard_runner="$repo_root/scripts/qa/lib/launch-owner-guard.mjs"
hmux_session_cleanup_runner="$repo_root/scripts/qa/lib/isolated-hmux-session-cleanup.mjs"
root_retirement_runner="$repo_root/scripts/qa/lib/isolated-root-retirement.mjs"
retirement_journal_root="$artifact_root/cleanup-transactions"
hmux_cli=${DURE_QA_HMUX_CLI:-${HEBBIAN_QA_HMUX_CLI:-}}
hmux_runtime=${DURE_QA_HMUX_RUNTIME:-${HEBBIAN_QA_HMUX_RUNTIME:-}}
dev_descriptor="$state_root/app-process-group.json"
client_descriptor="$state_root/client-process-group.json"
dev_frozen_snapshot="$state_root/app-frozen-processes.json"
client_frozen_snapshot="$state_root/client-frozen-processes.json"
dev_group_frozen_snapshot="$state_root/app-group-frozen-processes.json"
client_group_frozen_snapshot="$state_root/client-group-frozen-processes.json"
launch_owner_guard_root=$(mktemp -d "${TMPDIR:-/tmp}/dure-${artifact_name}-runner-owner.XXXXXX")
launch_owner_guard_descriptor="$launch_owner_guard_root/runner-owner.json"
launch_owner_guard_stop="$launch_owner_guard_root/stop"
launch_owner_guard_log="$launch_owner_guard_root/guard.log"
mkdir -p \
  "$qa_home/.dure" \
  "$qa_discovery" \
  "$qa_hmux_install" \
  "$qa_capture" \
  "$evidence_source"
ln -s .dure "$qa_home/.hebbian"
chmod 700 \
  "$qa_home" \
  "$qa_home/.dure" \
  "$qa_discovery" \
  "$qa_hmux_install" \
  "$qa_capture" \
  "$evidence_source" \
  "$launch_owner_guard_root"

real_home=${HOME:-}
export CARGO_HOME=${CARGO_HOME:-"$real_home/.cargo"}
export RUSTUP_HOME=${RUSTUP_HOME:-"$real_home/.rustup"}
export HEBBIAN_QA_STATE_ROOT="$state_root"
export HEBBIAN_QA_CAPTURE_DIR="$qa_capture"
export DURE_QA_STATE_ROOT="$state_root"
export DURE_QA_CAPTURE_DIR="$qa_capture"
export DURE_QA_APP_CHANNEL="$qa_app_channel"
if [ "$qa_app_channel" = "stable" ]; then
  qa_server_descriptor="$qa_home/.dure/server.json"
else
  qa_server_descriptor="$qa_home/.dure/channels/$qa_app_channel/server.json"
fi
export DURE_QA_SERVER_DESCRIPTOR="$qa_server_descriptor"

runner_pid=$$
dev_pid=
client_pid=
dev_supervisor_pid=
client_supervisor_pid=
client_owner_admitted=0
late_preflight_terminal=0
tee_pid=
monitor_pid=
hmux_reap_receipt=
dev_exit_receipt=
client_exit_receipt=
client_pipe_anchor_open=0
launch_owner_guard_pid=

close_client_pipe_anchor() {
  if [ "$client_pipe_anchor_open" -eq 1 ]; then
    exec 9>&-
    client_pipe_anchor_open=0
  fi
}

process_is_running() {
  target=$1
  state=$(ps -o stat= -p "$target" 2>/dev/null | tr -d ' ' || true)
  case "$state" in
    "" | Z*) return 1 ;;
    *) return 0 ;;
  esac
}

terminate_owned_pid() {
  target=$1
  [ -n "$target" ] || return
  parent=$(ps -o ppid= -p "$target" 2>/dev/null | tr -d ' ' || true)
  if process_is_running "$target" && [ "$parent" != "$runner_pid" ]; then
    echo "$qa_name: refusing to observe an unowned process $target" >&2
    return 1
  fi
  attempts=0
  while process_is_running "$target" && [ "$attempts" -lt 60 ]; do
    attempts=$((attempts + 1))
    sleep 0.05
  done
  if process_is_running "$target"; then
    echo "$qa_name: owned process $target did not exit; refusing a numeric-pid signal" >&2
    return 1
  fi
  wait "$target" 2>/dev/null || true
}

start_launch_owner_guard() {
  capture=${DURE_QA_TEST_LAUNCH_OWNER_GUARD_ROOT_CAPTURE:-${HEBBIAN_QA_TEST_LAUNCH_OWNER_GUARD_ROOT_CAPTURE:-}}
  test_mode=${DURE_QA_TEST_MODE:-${HEBBIAN_QA_TEST_MODE:-}}
  if [ -n "$test_mode" ] && [ -n "$capture" ]; then
    printf '%s\n' "$launch_owner_guard_root" >"$capture"
  fi
  env \
    DURE_QA_RUNNER_CANCEL_FILE="$runner_cancel_file" \
    DURE_QA_RUNNER_TIMEOUT_SECONDS="$runner_timeout_seconds" \
    node "$launch_owner_guard_runner" guard \
    "$launch_owner_guard_descriptor" \
    "$runner_pid" \
    "$launch_owner_guard_stop" \
    >"$launch_owner_guard_log" 2>&1 &
  launch_owner_guard_pid=$!
  attempts=0
  while [ ! -f "$launch_owner_guard_descriptor" ]; do
    if ! process_is_running "$launch_owner_guard_pid"; then
      wait "$launch_owner_guard_pid" 2>/dev/null || true
      cat "$launch_owner_guard_log" >&2 2>/dev/null || true
      launch_owner_guard_pid=
      return 1
    fi
    attempts=$((attempts + 1))
    [ "$attempts" -lt 1500 ] || return 1
    sleep 0.02
  done
}

stop_launch_owner_guard() {
  if [ -n "$launch_owner_guard_pid" ]; then
    : >"$launch_owner_guard_stop"
    attempts=0
    # The guard normally observes this within one 100ms poll. Keep the outer
    # wait tolerant of a CPU-starved self-hosted runner without ever signaling
    # its numeric PID.
    while process_is_running "$launch_owner_guard_pid" &&
      [ "$attempts" -lt 1500 ]; do
      attempts=$((attempts + 1))
      sleep 0.02
    done
    if process_is_running "$launch_owner_guard_pid"; then
      echo "$qa_name: launch-owner guard did not exit; preserving $launch_owner_guard_root" >&2
      return 1
    fi
    guard_status=0
    wait "$launch_owner_guard_pid" 2>/dev/null || guard_status=$?
    launch_owner_guard_pid=
    if [ "$guard_status" -ne 0 ]; then
      cat "$launch_owner_guard_log" >&2 2>/dev/null || true
      echo "$qa_name: launch-owner guard failed; preserving $launch_owner_guard_root" >&2
      return 1
    fi
  fi
  rm -f \
    "$launch_owner_guard_descriptor" \
    "$launch_owner_guard_stop" \
    "$launch_owner_guard_log"
  if ! rmdir "$launch_owner_guard_root"; then
    echo "$qa_name: launch-owner guard root is not empty; preserving $launch_owner_guard_root" >&2
    return 1
  fi
}

publish_runner_completion_receipt() {
  [ -n "$runner_completion_receipt" ] || return 0
  (
    umask 077
    set -C
    printf '%s\n' \
      '{"cleanup":"verified","schema":"dure-qa-tauri-app-runner/v1"}' \
      >"$runner_completion_receipt"
  )
}

freeze_owned_group() {
  operation=$1
  descriptor=$2
  supervisor=$3
  snapshot=$4
  [ -f "$descriptor" ] || return 1
  node "$process_group_runner" "$operation" \
    "$descriptor" \
    "$supervisor" \
    "$snapshot"
}

freeze_owned_group_with_retry() {
  operation=$1
  descriptor=$2
  supervisor=$3
  snapshot=$4
  if freeze_owned_group \
    "$operation" \
    "$descriptor" \
    "$supervisor" \
    "$snapshot"; then
    return 0
  fi
  # A helper can die after SIGSTOP but before publishing its snapshot. Re-enter
  # the generation-fenced freeze once while retaining the descriptor/ledger;
  # on success the normal Hmux-reap -> terminate-frozen -> verify ordering
  # remains intact. A second failure is uncertain and preserves the root.
  freeze_owned_group \
    "$operation" \
    "$descriptor" \
    "$supervisor" \
    "$snapshot"
}

terminate_frozen_owned_group() {
  descriptor=$1
  supervisor=$2
  snapshot=$3
  node "$process_group_runner" terminate-frozen \
    "$descriptor" \
    "$supervisor" \
    "$snapshot"
}

verify_owned_group_exited() {
  descriptor=$1
  supervisor=$2
  node "$process_group_runner" verify-exited \
    "$descriptor" \
    "$supervisor"
}

wait_owned_group_ready() {
  descriptor=$1
  supervisor=$2
  attempts=0
  while [ ! -f "$descriptor" ]; do
    if ! process_is_running "$supervisor"; then
      wait "$supervisor" 2>/dev/null || true
      return 1
    fi
    attempts=$((attempts + 1))
    # Node startup can be delayed while the full Vitest suite saturates the
    # self-hosted runner. Keep the wait bounded, but do not classify a live
    # supervisor as failed at the old nominal five-second boundary.
    [ "$attempts" -lt 1500 ] || return 1
    sleep 0.02
  done
  node "$process_group_runner" inspect "$descriptor" "$supervisor"
}

wait_for_app_ready() {
  readiness_waits=0
  while :; do
    if [ "$qa_layer" = "background" ] && [ -f "$background_focus_observation_failure" ]; then
      failure_class=background_focus_observation
      echo "$qa_name: could not verify foreground process ownership during startup" >&2
      return 24
    fi
    if [ "$qa_layer" = "background" ] && [ -f "$background_focus_violation" ]; then
      failure_class=background_focus_activation
      echo "$qa_name: background QA app took foreground focus during startup" >&2
      return 23
    fi
    [ ! -f "$qa_server_descriptor" ] || return 0
    if ! process_is_running "$dev_supervisor_pid"; then
      echo "$qa_name: QA app exited before publishing its server descriptor" >&2
      return 1
    fi
    # A clean Tauri debug build can exceed three minutes on a loaded
    # self-hosted machine. Bound app startup independently so client workload
    # deadlines begin only after the native app is ready.
    if [ "$readiness_waits" -ge 6000 ]; then
      echo "$qa_name: timed out waiting for the QA app to become ready" >&2
      return 1
    fi
    readiness_waits=$((readiness_waits + 1))
    sleep 0.1
  done
}

reap_hmux_sessions() {
  set -- node "$hmux_session_cleanup_runner" reap \
    "$state_root" \
    "$qa_discovery" \
    "$hmux_cli" \
    "$hmux_runtime"
  if [ -n "$dev_supervisor_pid" ] && [ -f "$dev_descriptor" ]; then
    set -- "$@" "$dev_descriptor" "$dev_supervisor_pid"
  fi
  if [ -n "$client_supervisor_pid" ] && [ -f "$client_descriptor" ]; then
    set -- "$@" "$client_descriptor" "$client_supervisor_pid"
  fi
  receipt=$("$@") || return $?
  if [ -z "$receipt" ]; then
    echo "$qa_name: Hmux cleanup returned no generation receipt" >&2
    return 1
  fi
  if [ -z "$hmux_reap_receipt" ]; then
    # Keep the first verified generation. A later reap observes quiescence but
    # must not authorize retirement of a root replaced during cleanup.
    hmux_reap_receipt=$receipt
  fi
  printf '%s\n' "$receipt"
}

abort_active_qa() {
  descriptor="$qa_server_descriptor"
  [ -f "$descriptor" ] || return 0
  DURE_QA_SERVER_DESCRIPTOR="$descriptor" node --input-type=module -e '
    import fs from "node:fs";
    const descriptor = JSON.parse(
      fs.readFileSync(process.env.DURE_QA_SERVER_DESCRIPTOR, "utf8"),
    );
    const response = await fetch(
      `http://127.0.0.1:${descriptor.port}/qa/hmux/window-focus/abort`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${descriptor.token}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) process.exitCode = 1;
  ' >/dev/null 2>&1 || true
}

stop_monitor() {
  [ -n "$monitor_pid" ] || return 0
  : >"$monitor_stop"
  monitor_attempts=0
  while kill -0 "$monitor_pid" 2>/dev/null && [ "$monitor_attempts" -lt 40 ]; do
    monitor_attempts=$((monitor_attempts + 1))
    sleep 0.05
  done
  if kill -0 "$monitor_pid" 2>/dev/null; then
    terminate_owned_pid "$monitor_pid"
  fi
  wait "$monitor_pid" 2>/dev/null || true
  monitor_pid=
}

publish_failure_evidence() {
  status=$1
  if artifact_dir=$(
    node scripts/qa/lib/evidence-bundle.mjs \
      --result failed \
      --qa-name "$qa_name" \
      --exit-code "$status" \
      --artifact-root "$artifact_root" \
      --tauri-log "$app_log" \
      --client-log "$client_log" \
      --last-status "$evidence_source/last-status.json" \
      --commit "$commit_sha" \
      --tree "$tree_sha" \
      --dirty "$dirty" \
      --started-at-ms "$started_at_ms" \
      --qa-layer "$qa_layer" \
      --failure-class "$failure_class" \
      --state-root "$state_root" \
      --developer-home "$real_home"
  ); then
    echo "$qa_name: redacted failure evidence saved to $artifact_dir" >&2
    if [ -f "$artifact_dir/tauri-dev.log" ]; then
      echo "$qa_name: redacted Tauri log tail follows" >&2
      tail -n 200 "$artifact_dir/tauri-dev.log" >&2 || true
    fi
  else
    echo "$qa_name: failure evidence could not be saved" >&2
  fi
}

fail_background_monitor() {
  if [ -f "$background_focus_observation_failure" ]; then
    failure_class=background_focus_observation
    exit 24
  fi
  failure_class=background_focus_activation
  exit 23
}

cleanup() {
  status=$?
  trap '' USR1 USR2
  trap - EXIT
  trap ':' HUP INT TERM
  set +e
  close_client_pipe_anchor
  cleanup_failed=0
  verified_pre_client_terminal=0
  if [ "$late_preflight_terminal" -eq 1 ] &&
    [ "$client_owner_admitted" -eq 0 ] &&
    { [ "$status" -eq 0 ] || [ "$status" -eq 22 ]; }; then
    verified_pre_client_terminal=1
  fi
  client_cleanup_observed=0
  dev_cleanup_observed=0
  manifest_cleanup_observed=0
  client_frozen=0
  dev_frozen=0
  client_group_frozen=0
  dev_group_frozen=0
  stop_monitor
  if [ "$?" -ne 0 ]; then
    cleanup_failed=1
  fi
  abort_active_qa
  if [ -n "$client_supervisor_pid" ]; then
    if freeze_owned_group_with_retry \
      freeze-group \
      "$client_descriptor" \
      "$client_supervisor_pid" \
      "$client_group_frozen_snapshot"; then
      client_group_frozen=1
    else
      cleanup_failed=1
    fi
  elif [ "$client_owner_admitted" -eq 0 ]; then
    client_frozen=1
    client_group_frozen=1
    client_cleanup_observed=1
  else
    cleanup_failed=1
  fi
  if [ -n "$dev_supervisor_pid" ]; then
    if freeze_owned_group_with_retry \
      freeze-group \
      "$dev_descriptor" \
      "$dev_supervisor_pid" \
      "$dev_group_frozen_snapshot"; then
      dev_group_frozen=1
    else
      cleanup_failed=1
    fi
  else
    dev_frozen=1
    dev_group_frozen=1
    dev_cleanup_observed=1
  fi

  if ! reap_hmux_sessions; then
    cleanup_failed=1
  fi

  if [ -n "$client_supervisor_pid" ] &&
    [ "$client_group_frozen" -eq 1 ]; then
    if freeze_owned_group_with_retry \
      freeze \
      "$client_descriptor" \
      "$client_supervisor_pid" \
      "$client_frozen_snapshot"; then
      client_frozen=1
    else
      cleanup_failed=1
    fi
  fi
  if [ -n "$dev_supervisor_pid" ] && [ "$dev_group_frozen" -eq 1 ]; then
    if freeze_owned_group_with_retry \
      freeze \
      "$dev_descriptor" \
      "$dev_supervisor_pid" \
      "$dev_frozen_snapshot"; then
      dev_frozen=1
    else
      cleanup_failed=1
    fi
  fi

  if [ -n "$client_supervisor_pid" ] && [ "$client_frozen" -eq 1 ]; then
    if terminate_frozen_owned_group \
      "$client_descriptor" \
      "$client_supervisor_pid" \
      "$client_frozen_snapshot"; then
      if client_exit_receipt=$(verify_owned_group_exited \
        "$client_descriptor" \
        "$client_supervisor_pid") &&
        [ -n "$client_exit_receipt" ]; then
        client_cleanup_observed=1
      else
        cleanup_failed=1
      fi
    else
      cleanup_failed=1
    fi
  fi
  if [ -n "$dev_supervisor_pid" ] && [ "$dev_frozen" -eq 1 ]; then
    if terminate_frozen_owned_group \
      "$dev_descriptor" \
      "$dev_supervisor_pid" \
      "$dev_frozen_snapshot"; then
      if dev_exit_receipt=$(verify_owned_group_exited \
        "$dev_descriptor" \
        "$dev_supervisor_pid") &&
        [ -n "$dev_exit_receipt" ]; then
        dev_cleanup_observed=1
      else
        cleanup_failed=1
      fi
    else
      cleanup_failed=1
    fi
  fi
  if [ -n "$tee_pid" ]; then
    terminate_owned_pid "$tee_pid"
    if [ "$?" -ne 0 ]; then
      cleanup_failed=1
    fi
  fi
  if [ "$client_cleanup_observed" -eq 1 ] &&
    [ "$dev_cleanup_observed" -eq 1 ] &&
    reap_hmux_sessions; then
    manifest_cleanup_observed=1
  else
    cleanup_failed=1
  fi
  if [ "$client_cleanup_observed" -ne 1 ] ||
    [ "$dev_cleanup_observed" -ne 1 ] ||
    [ "$manifest_cleanup_observed" -ne 1 ]; then
    cleanup_failed=1
  fi
  if [ "$status" -eq 0 ] && [ "$cleanup_failed" -ne 0 ]; then
    status=1
  fi
  if [ "$status" -ne 0 ]; then
    publish_failure_evidence "$status"
  fi
  if [ "$cleanup_failed" -eq 0 ] &&
    [ "$client_cleanup_observed" -eq 1 ] &&
    [ "$dev_cleanup_observed" -eq 1 ] &&
    [ "$manifest_cleanup_observed" -eq 1 ]; then
    if [ -z "$hmux_reap_receipt" ] ||
      [ -z "$dev_exit_receipt" ] ||
      { [ "$verified_pre_client_terminal" -ne 1 ] && [ -z "$client_exit_receipt" ]; }; then
      cleanup_failed=1
      if [ "$status" -eq 0 ]; then
        status=1
        publish_failure_evidence "$status"
      fi
      echo "$qa_name: incomplete cleanup capability receipts; preserving $state_root" >&2
    elif [ "$verified_pre_client_terminal" -eq 1 ]; then
      echo "$qa_name: cleanup verified before client startup; preserving $state_root" >&2
    else
      node "$root_retirement_runner" retire \
        "$state_root" \
        "$retirement_journal_root" \
        "$hmux_reap_receipt" \
        "$dev_exit_receipt" \
        "$client_exit_receipt" >/dev/null
      retirement_status=$?
      case "$retirement_status" in
        0)
          echo "$qa_name: cleanup verified; retired isolated root $state_root" >&2
          ;;
        2)
          echo "$qa_name: cleanup verified without generation-atomic process containment; preserving $state_root" >&2
          ;;
        *)
          cleanup_failed=1
          if [ "$status" -eq 0 ]; then
            status=1
            publish_failure_evidence "$status"
          fi
          echo "$qa_name: isolated root retirement failed; inspect $retirement_journal_root" >&2
          ;;
      esac
    fi
  else
    echo "$qa_name: cleanup ownership is uncertain; preserving $state_root" >&2
  fi
  if ! stop_launch_owner_guard; then
    cleanup_failed=1
    if [ "$status" -eq 0 ]; then
      status=1
    fi
  fi
  if [ "$cleanup_failed" -eq 0 ] &&
    ! publish_runner_completion_receipt; then
    cleanup_failed=1
    if [ "$status" -eq 0 ]; then
      status=1
    fi
    echo "$qa_name: runner cleanup receipt could not be published" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'failure_class=exclusive_user_activity; exit 21' USR1
trap fail_background_monitor USR2

failure_class=runner_owner_guard
if ! start_launch_owner_guard; then
  echo "$qa_name: launch-owner guard did not publish exact generations" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1 || ! command -v rustc >/dev/null 2>&1; then
  for rust_bin in \
    "$RUSTUP_HOME"/toolchains/stable-*/bin \
    "$RUSTUP_HOME"/toolchains/*/bin; do
    if [ -x "$rust_bin/cargo" ] && [ -x "$rust_bin/rustc" ]; then
      PATH="$rust_bin:$PATH"
      export PATH
      break
    fi
  done
fi
if ! command -v cargo >/dev/null 2>&1 || ! command -v rustc >/dev/null 2>&1; then
  echo "$qa_name: cargo and rustc are required; repair the rustup shims or configure RUSTUP_HOME" >&2
  exit 1
fi

failure_class=runtime_stage
pnpm hmux:runtime:stage:dev
expected_hmux_build_id=${HMUX_BUILD_ID:-$(node scripts/hmux-dev-build-id.mjs)}
case "$expected_hmux_build_id" in
  "" | *[!A-Za-z0-9._+-]*)
    echo "$qa_name: staged Hmux build identity is invalid" >&2
    exit 1
    ;;
esac

failure_class=dure_cli_install
if [ -z "$hmux_cli" ] || [ -z "$hmux_runtime" ]; then
  hmux_target_triple=${CARGO_BUILD_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}
  if [ -z "$hmux_target_triple" ]; then
    echo "$qa_name: could not determine the Hmux target triple" >&2
    exit 1
  fi
  hmux_cli=${hmux_cli:-"$repo_root/src-tauri/binaries/hmux-$hmux_target_triple"}
  hmux_runtime=${hmux_runtime:-"$repo_root/src-tauri/binaries/hmux-runtime-$hmux_target_triple"}
fi
qa_cli_install_root="$qa_home/.local/share/hebbian-ide-cli"
qa_cli_install_dir="$qa_home/.local/bin"
if [ "$qa_app_channel" != "stable" ]; then
  qa_cli_install_root="$qa_cli_install_root/channels/$qa_app_channel"
  qa_cli_install_dir="$qa_cli_install_root/bin"
fi
case "$qa_cli_install_root" in
  "$qa_home"/*) ;;
  *)
    echo "$qa_name: isolated CLI install root escaped the QA home" >&2
    exit 1
    ;;
esac
case "$qa_cli_install_dir" in
  "$qa_home"/*) ;;
  *)
    echo "$qa_name: isolated CLI command directory escaped the QA home" >&2
    exit 1
    ;;
esac
DURE_CLI_INSTALL_ROOT="$qa_cli_install_root" \
  DURE_CLI_INSTALL_DIR="$qa_cli_install_dir" \
  DURE_APP_CHANNEL="$qa_app_channel" \
  DURE_HMUX_BIN="$hmux_cli" \
  DURE_HMUX_RUNTIME_BIN="$hmux_runtime" \
  DURE_HMUX_BUILD_ID="$expected_hmux_build_id" \
  node "$repo_root/scripts/install-dure-cli.mjs"

if [ -n "$qa_home_setup" ]; then
  setup_directory=$(CDPATH= cd -- "$(dirname "$qa_home_setup")" && pwd -P) || {
    echo "$qa_name: QA home setup directory is unavailable" >&2
    exit 1
  }
  setup_path="$setup_directory/$(basename "$qa_home_setup")"
  case "$setup_path" in
    "$repo_root"/scripts/qa/*) ;;
    *)
      echo "$qa_name: QA home setup must be a repository scripts/qa file" >&2
      exit 1
      ;;
  esac
  if [ ! -f "$setup_path" ] || [ -L "$setup_path" ]; then
    echo "$qa_name: QA home setup must be a real file" >&2
    exit 1
  fi
  failure_class=home_setup
  HOME="$qa_home" \
  DURE_HOME="$qa_home/.dure" \
  DURE_HMUX_BIN="$hmux_cli" \
  DURE_HMUX_RUNTIME_BIN="$hmux_runtime" \
  HMUX_DISCOVERY_ROOT="$qa_discovery" \
  HMUX_INSTALL_ROOT="$qa_hmux_install" \
    sh scripts/qa/lib/run-isolated-app.sh node "$setup_path"
fi

vite_port=$(
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(server.address().port));
      server.close();
    });
  '
)
config=$(
  DURE_QA_VITE_PORT="$vite_port" \
  DURE_QA_WINDOW_TITLE="$window_title" \
  DURE_QA_WINDOW_URL="$window_url" \
  DURE_QA_LAYER="$qa_layer" \
    node scripts/qa/lib/tauri-window-config.mjs
)

failure_class=app_execution
HOME="$qa_home" \
DURE_HOME="$qa_home/.dure" \
DURE_HMUX_BIN="$hmux_cli" \
DURE_HMUX_RUNTIME_BIN="$hmux_runtime" \
HMUX_DISCOVERY_ROOT="$qa_discovery" \
HMUX_INSTALL_ROOT="$qa_hmux_install" \
DURE_DEV_WEBVIEW_DATA_STORE_IDENTIFIER="$qa_webview_data_store_identifier" \
DURE_QA_LAYER="$qa_layer" \
HEBBIAN_QA_LAYER="$qa_layer" \
node "$process_group_runner" run-observed "$dev_descriptor" -- \
  sh scripts/qa/lib/run-isolated-app.sh \
    node "$repo_root/scripts/qa/lib/tauri-app-launch.mjs" "$config" >"$app_log" 2>&1 &
dev_supervisor_pid=$!
if [ "$qa_layer" = "background" ]; then
  (
    front_tool=${DURE_QA_TEST_FRONT_TOOL:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsappinfo}
    while kill -0 "$runner_pid" 2>/dev/null && [ ! -f "$monitor_stop" ]; do
      front_asn=$($front_tool front 2>/dev/null || true)
      front_pid=$($front_tool info -only pid "$front_asn" 2>/dev/null |
        sed -n 's/.*pid = \([0-9][0-9]*\).*/\1/p')
      if [ -n "$front_pid" ] && [ -f "$dev_descriptor" ]; then
        set +e
        node "$process_group_runner" contains-live-pid \
          "$dev_descriptor" "$dev_supervisor_pid" "$front_pid" \
          >/dev/null 2>&1
        ownership_status=$?
        set -e
        case "$ownership_status" in
          0)
            [ ! -f "$monitor_stop" ] || exit 0
            (set -C; : >"$background_focus_violation") 2>/dev/null || true
            kill -USR2 "$runner_pid" 2>/dev/null || true
            exit 0
            ;;
          1) ;;
          *)
            [ ! -f "$monitor_stop" ] || exit 0
            (
              set -C
              printf '%s\n' "$ownership_status" \
                >"$background_focus_observation_failure"
            ) 2>/dev/null || true
            kill -USR2 "$runner_pid" 2>/dev/null || true
            exit 0
            ;;
        esac
      fi
      sleep 0.1
    done
  ) &
  monitor_pid=$!
fi

if ! dev_pid=$(wait_owned_group_ready "$dev_descriptor" "$dev_supervisor_pid"); then
  echo "$qa_name: isolated app process group did not become ready" >&2
  exit 1
fi
failure_class=app_readiness
set +e
wait_for_app_ready
app_readiness_status=$?
set -e
[ "$app_readiness_status" -eq 0 ] || exit "$app_readiness_status"

case "$qa_layer" in
  exclusive_focus*)
    failure_class=exclusive_preflight
    set +e
    late_decision=$(node scripts/qa/lib/exclusive-focus-preflight.mjs)
    late_status=$?
    set -e
    case "$late_status" in
      0) ;;
      20)
        echo "$qa_name: SKIP $late_decision" >&2
        late_preflight_terminal=1
        if [ "${DURE_QA_REQUIRE_EXECUTION:-${HEBBIAN_QA_REQUIRE_EXECUTION:-0}}" = "1" ]; then
          exit 22
        fi
        exit 0
        ;;
      *)
        echo "$qa_name: late exclusive focus preflight failed: $late_decision" >&2
        exit "$late_status"
        ;;
    esac

    failure_class=exclusive_user_activity
    (
      while kill -0 "$runner_pid" 2>/dev/null && [ ! -f "$monitor_stop" ]; do
        if [ -f "$exclusive_input_request" ] && [ ! -L "$exclusive_input_request" ]; then
          if node scripts/qa/lib/exclusive-focus-preflight.mjs >/dev/null 2>&1; then
            if node -e 'require("node:fs").writeFileSync(process.argv[1], "", { flag: "wx", mode: 0o600 })' "$exclusive_input_ack" 2>/dev/null; then
              exit 0
            fi
          fi
          [ ! -f "$monitor_stop" ] || exit 0
          kill -USR1 "$runner_pid" 2>/dev/null || true
          exit 0
        fi
        if ! node scripts/qa/lib/exclusive-focus-preflight.mjs >/dev/null 2>&1; then
          [ ! -f "$monitor_stop" ] || exit 0
          kill -USR1 "$runner_pid" 2>/dev/null || true
          exit 0
        fi
        sleep 0.25
      done
    ) &
    monitor_pid=$!
    ;;
esac

mkfifo "$client_pipe"
# A background redirection can outlive the runner while blocked in open(2) if
# cancellation lands before the writer starts. The owner-held RDWR anchor makes
# both child opens nonblocking; children close the inherited anchor so EOF still
# proves that the real writer exited.
exec 9<>"$client_pipe"
client_pipe_anchor_open=1
tee "$client_log" <"$client_pipe" 9>&- &
tee_pid=$!

failure_class=app_execution
client_owner_admitted=1
DURE_QA_ROOT_PID="$dev_pid" \
HEBBIAN_QA_ROOT_PID="$dev_pid" \
HOME="$qa_home" \
DURE_HOME="$qa_home/.dure" \
DURE_HMUX_BIN="$hmux_cli" \
DURE_HMUX_RUNTIME_BIN="$hmux_runtime" \
HMUX_DISCOVERY_ROOT="$qa_discovery" \
HMUX_INSTALL_ROOT="$qa_hmux_install" \
DURE_APP_CHANNEL="$qa_app_channel" \
DURE_QA_EXPECTED_HMUX_BUILD_ID="$expected_hmux_build_id" \
DURE_QA_HMUX_CLI="$hmux_cli" \
DURE_QA_EVIDENCE_DIR="$evidence_source" \
HEBBIAN_QA_EVIDENCE_DIR="$evidence_source" \
DURE_QA_EXCLUSIVE_INPUT_REQUEST="$exclusive_input_request" \
DURE_QA_EXCLUSIVE_INPUT_ACK="$exclusive_input_ack" \
DURE_QA_LAYER="$qa_layer" \
HEBBIAN_QA_LAYER="$qa_layer" \
  node "$process_group_runner" run-observed "$client_descriptor" -- \
  sh scripts/qa/lib/run-isolated-app.sh \
  node "$qa_client" 9>&- >"$client_pipe" 2>&1 &
client_supervisor_pid=$!
if ! client_pid=$(
  wait_owned_group_ready "$client_descriptor" "$client_supervisor_pid"
); then
  echo "$qa_name: QA client process group did not become ready" >&2
  exit 1
fi
# Published ownership proves the client has opened its output writer. Closing
# earlier can let tee observe EOF between the child's anchor close and open.
close_client_pipe_anchor

client_status=0
wait "$client_supervisor_pid" || client_status=$?

tee_status=0
wait "$tee_pid" || tee_status=$?
tee_pid=
rm -f "$client_pipe"

qa_status=$client_status
if [ "$qa_status" -eq 0 ] && [ "$tee_status" -ne 0 ]; then
  qa_status=$tee_status
fi
exit "$qa_status"
