#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <ssh-target>" >&2
  exit 2
fi

ssh_target=$1
case "$ssh_target" in
  -*)
    echo "hmux remote soak: ssh target must not begin with '-'" >&2
    exit 2
    ;;
esac

timeout_seconds=${HMUX_REMOTE_SOAK_TIMEOUT_SECONDS:-120}
screen_reads=${HMUX_REMOTE_SOAK_SCREEN_READS:-25}
cleanup_kill_grace_seconds=15
for bounded_number in "$timeout_seconds" "$screen_reads"; do
  if ! printf '%s\n' "$bounded_number" | grep -Eq '^[0-9]+$'; then
    echo "hmux remote soak: timeout and screen-read budgets must be integers" >&2
    exit 2
  fi
done
if [ "$timeout_seconds" -lt 30 ] || [ "$timeout_seconds" -gt 900 ]; then
  echo "hmux remote soak: timeout must be between 30 and 900 seconds" >&2
  exit 2
fi
if [ "$screen_reads" -lt 1 ] || [ "$screen_reads" -gt 10000 ]; then
  echo "hmux remote soak: screen-read count must be between 1 and 10000" >&2
  exit 2
fi

ssh_program=${HMUX_QA_SSH_PROGRAM:-ssh}
if ! command -v "$ssh_program" >/dev/null 2>&1; then
  echo "hmux remote soak: ssh program is not executable: $ssh_program" >&2
  exit 1
fi

# The command string contains only the two numeric values validated above.
# `timeout` owns the whole remote shell, while SSH keepalives bound a carrier
# that stops answering before the remote process can receive a signal.
"$ssh_program" \
  -T \
  -o BatchMode=yes \
  -o ConnectTimeout=8 \
  -o ServerAliveInterval=5 \
  -o ServerAliveCountMax=3 \
  "$ssh_target" \
  "timeout -k ${cleanup_kill_grace_seconds}s ${timeout_seconds}s sh -s -- $screen_reads" <<'REMOTE'
set -eu

screen_reads=$1
hmux="$HOME/.local/bin/hmux"
if [ ! -x "$hmux" ]; then
  echo "hmux remote soak: $hmux is not executable" >&2
  exit 1
fi
for command in jq timeout; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "hmux remote soak: required command is missing: $command" >&2
    exit 1
  fi
done

qa_root=$(mktemp -d "${TMPDIR:-/tmp}/hmux-remote-soak.XXXXXX")
case "$qa_root" in
  /*/hmux-remote-soak.*) ;;
  *)
    echo "hmux remote soak: mktemp returned an unsafe root" >&2
    exit 1
    ;;
esac
chmod 700 "$qa_root"
discovery_root="$qa_root/discovery"
name="hebbianide-soak-$(date +%Y%m%d-%H%M%S)-$$"
attach_one="$qa_root/attach-one"
attach_two="$qa_root/attach-two"
session_id=
session_generation=
host_pid=
host_start_marker=
provider_pid=
provider_start_marker=
create_succeeded=0
cleanup_complete=0

hmux_cmd() {
  "$hmux" --discovery-root "$discovery_root" "$@"
}

list_sessions() {
  hmux_cmd ls --json
}

cleanup_owned_state() {
  if [ "$cleanup_complete" -eq 1 ]; then
    return 0
  fi
  if [ ! -d "$qa_root" ]; then
    cleanup_complete=1
    return 0
  fi

  cleanup_failed=0
  cleanup_sessions=
  if cleanup_sessions=$(list_sessions 2>/dev/null); then
    if ! printf '%s' "$cleanup_sessions" |
      jq -e 'type == "array"' >/dev/null; then
      cleanup_failed=1
    fi
  else
    cleanup_failed=1
  fi

  if [ "$cleanup_failed" -eq 0 ]; then
    cleanup_total=$(printf '%s' "$cleanup_sessions" | jq 'length')
    cleanup_owned=$(printf '%s' "$cleanup_sessions" |
      jq --arg name "$name" '[.[] | select(.session_name == $name)] | length')
    if [ "$cleanup_total" -ne "$cleanup_owned" ] ||
      [ "$cleanup_owned" -gt 1 ]; then
      cleanup_failed=1
    elif [ "$cleanup_owned" -eq 1 ]; then
      cleanup_session_id=$(printf '%s' "$cleanup_sessions" |
        jq -er --arg name "$name" \
          '.[] | select(.session_name == $name) | .session_id | select(type == "string")') ||
        cleanup_failed=1
      if [ -z "$host_pid" ]; then
        host_pid=$(printf '%s' "$cleanup_sessions" |
          jq -er --arg name "$name" \
            '.[] | select(.session_name == $name)
              | .host_process.process_id
              | select(type == "number" and floor == .)') ||
          cleanup_failed=1
      fi
      if [ -z "$host_start_marker" ]; then
        host_start_marker=$(printf '%s' "$cleanup_sessions" |
          jq -er --arg name "$name" \
            '.[] | select(.session_name == $name)
              | .host_process.start_marker
              | select(type == "string")') ||
          cleanup_failed=1
      fi
      if [ -z "$provider_pid" ]; then
        provider_pid=$(printf '%s' "$cleanup_sessions" |
          jq -er --arg name "$name" \
            '.[] | select(.session_name == $name)
              | .provider_process.process_id
              | select(type == "number" and floor == .)') ||
          cleanup_failed=1
      fi
      if [ -z "$provider_start_marker" ]; then
        provider_start_marker=$(printf '%s' "$cleanup_sessions" |
          jq -er --arg name "$name" \
            '.[] | select(.session_name == $name)
              | .provider_process.start_marker
              | select(type == "string")') ||
          cleanup_failed=1
      fi
      if [ -z "$session_generation" ]; then
        session_generation=$(printf '%s' "$cleanup_sessions" |
          jq -cer --arg name "$name" \
            '.[] | select(.session_name == $name)
              | select(
                  [
                    .workspace_id,
                    .runner_principal,
                    .runner_instance,
                    .channel_epoch,
                    .host_instance_id,
                    .terminal_epoch
                  ] | all(type == "string" and length > 0)
                )
              | {
                  workspace_id,
                  session_id,
                  runner_principal,
                  runner_instance,
                  channel_epoch,
                  host_instance_id,
                  terminal_epoch
                }') ||
          cleanup_failed=1
      fi
      if [ -n "$session_id" ] &&
        [ "$cleanup_session_id" != "$session_id" ]; then
        cleanup_failed=1
      else
        session_id=$cleanup_session_id
      fi
      if [ "$cleanup_failed" -eq 0 ] &&
        ! printf '%s' "$cleanup_sessions" |
          jq -e \
            --arg name "$name" \
            --arg session_id "$session_id" \
            --arg start_marker "$host_start_marker" \
            --argjson host_pid "$host_pid" \
            --arg provider_start_marker "$provider_start_marker" \
            --argjson provider_pid "$provider_pid" \
            --argjson generation "$session_generation" \
            'def generation: {
              workspace_id,
              session_id,
              runner_principal,
              runner_instance,
              channel_epoch,
              host_instance_id,
              terminal_epoch
            };
            .[] | select(
              .session_name == $name
              and generation == $generation
              and .session_id == $session_id
              and .host_process.process_id == $host_pid
              and .host_process.start_marker == $start_marker
              and .provider_process.process_id == $provider_pid
              and .provider_process.start_marker == $provider_start_marker
              and (.lifecycle == "ready" or .lifecycle == "exited")
            )' >/dev/null; then
        cleanup_failed=1
      fi
      # This is intentionally idempotent for an already-exited descriptor. The
      # CLI rechecks its exit reason and refuses cleanup that left any provider
      # process-session member behind. The fence is consumed by the same CLI
      # process that resolves the LocalSession, closing the census/kill race.
      if [ "$cleanup_failed" -eq 0 ] &&
        ! hmux_cmd kill "$cleanup_session_id" \
          --expected-fence-json "$session_generation" >/dev/null 2>&1; then
        cleanup_failed=1
      fi
    fi
  fi

  if [ "$cleanup_failed" -eq 0 ] &&
    [ "$cleanup_owned" -eq 0 ] &&
    [ "$create_succeeded" -eq 1 ]; then
    if [ -z "$session_generation" ] ||
      [ -z "$host_pid" ] ||
      [ -z "$provider_pid" ]; then
      # `new` returned a session identity, but no later census yielded every
      # process and fence proof. Absence cannot retire an unobserved generation.
      cleanup_failed=1
    fi
  fi

  cleanup_attempt=0
  cleanup_retired=0
  while [ "$cleanup_failed" -eq 0 ] && [ "$cleanup_attempt" -lt 50 ]; do
    cleanup_sessions=$(list_sessions 2>/dev/null) || {
      cleanup_failed=1
      break
    }
    if ! printf '%s' "$cleanup_sessions" |
      jq -e --arg name "$name" \
        'type == "array"
          and ([.[] | select(.session_name != $name)] | length == 0)
          and length <= 1' >/dev/null; then
      cleanup_failed=1
      break
    fi
    if printf '%s' "$cleanup_sessions" | jq -e 'length == 0' >/dev/null; then
      cleanup_retired=1
      break
    fi
    if printf '%s' "$cleanup_sessions" |
      jq -e \
        --arg name "$name" \
        --arg session_id "$session_id" \
        --arg start_marker "$host_start_marker" \
        --argjson host_pid "$host_pid" \
        --arg provider_start_marker "$provider_start_marker" \
        --argjson provider_pid "$provider_pid" \
        --argjson generation "$session_generation" \
        'def generation: {
          workspace_id,
          session_id,
          runner_principal,
          runner_instance,
          channel_epoch,
          host_instance_id,
          terminal_epoch
        };
        length == 1 and .[0].session_name == $name
          and (.[0] | generation) == $generation
          and .[0].session_id == $session_id
          and .[0].host_process.process_id == $host_pid
          and .[0].host_process.start_marker == $start_marker
          and .[0].provider_process.process_id == $provider_pid
          and .[0].provider_process.start_marker == $provider_start_marker
          and .[0].lifecycle == "exited"' >/dev/null; then
      cleanup_retired=1
      break
    fi
    if printf '%s' "$cleanup_sessions" |
      jq -e \
        --arg name "$name" \
        --arg session_id "$session_id" \
        --arg start_marker "$host_start_marker" \
        --argjson host_pid "$host_pid" \
        --arg provider_start_marker "$provider_start_marker" \
        --argjson provider_pid "$provider_pid" \
        --argjson generation "$session_generation" \
        'def generation: {
          workspace_id,
          session_id,
          runner_principal,
          runner_instance,
          channel_epoch,
          host_instance_id,
          terminal_epoch
        };
        length == 1 and .[0].session_name == $name
          and (.[0] | generation) == $generation
          and .[0].session_id == $session_id
          and .[0].host_process.process_id == $host_pid
          and .[0].host_process.start_marker == $start_marker
          and .[0].provider_process.process_id == $provider_pid
          and .[0].provider_process.start_marker == $provider_start_marker
          and .[0].lifecycle == "ready"' >/dev/null; then
      cleanup_attempt=$((cleanup_attempt + 1))
      sleep 0.1
      continue
    fi
    cleanup_failed=1
    break
  done
  if [ "$cleanup_failed" -eq 0 ] && [ "$cleanup_retired" -ne 1 ]; then
    cleanup_failed=1
  fi

  owned_processes_alive() {
    if [ -n "$host_pid" ] && kill -0 "$host_pid" 2>/dev/null; then
      return 0
    fi
    if [ -n "$provider_pid" ] && kill -0 "$provider_pid" 2>/dev/null; then
      return 0
    fi
    return 1
  }
  cleanup_attempt=0
  while [ "$cleanup_failed" -eq 0 ] && owned_processes_alive; do
    if [ "$cleanup_attempt" -ge 50 ]; then
      cleanup_failed=1
      break
    fi
    cleanup_attempt=$((cleanup_attempt + 1))
    sleep 0.1
  done

  if [ "$cleanup_failed" -ne 0 ]; then
    echo \
      "hmux remote soak: cleanup was not proven; isolated evidence preserved at $qa_root" \
      >&2
    return 1
  fi

  case "$qa_root" in
    /*/hmux-remote-soak.*)
      if ! rm -r -- "$qa_root"; then
        echo "hmux remote soak: could not remove isolated root: $qa_root" >&2
        return 1
      fi
      ;;
    *)
      echo "hmux remote soak: refusing unexpected cleanup root: $qa_root" >&2
      return 1
      ;;
  esac
  cleanup_complete=1
  return 0
}

on_exit() {
  status=$?
  trap - EXIT
  if ! cleanup_owned_state; then
    status=1
  fi
  exit "$status"
}
on_signal() {
  status=$1
  echo \
    "hmux remote soak: signal received; cleanup begins for ${qa_root:-unallocated} session=${session_id:-unknown} host_pid=${host_pid:-unknown}" \
    >&2
  exit "$status"
}
trap on_exit EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

capabilities=$(hmux_cmd --json capabilities)
if ! printf '%s' "$capabilities" |
  jq -e '
    .capabilities as $capabilities
    | ($capabilities | type == "array")
      and ($capabilities | index("generation_fenced_kill_v1") != null)
  ' >/dev/null; then
  echo \
    "hmux remote soak: installed CLI lacks generation_fenced_kill_v1" \
    >&2
  exit 1
fi

before=$(list_sessions)
if ! printf '%s' "$before" | jq -e 'type == "array" and length == 0' >/dev/null; then
  echo "hmux remote soak: isolated discovery root was not empty" >&2
  exit 1
fi

create=$(hmux_cmd new --json --name "$name")
session_id=$(printf '%s' "$create" |
  jq -er '.sessionId | select(type == "string" and length > 0)')
create_succeeded=1

current=$(list_sessions)
if ! printf '%s' "$current" |
  jq -e --arg name "$name" \
    '[.[] | select(.session_name == $name and .lifecycle == "ready")] | length == 1' \
    >/dev/null; then
  echo "hmux remote soak: created session did not become uniquely ready" >&2
  exit 1
fi
host_pid=$(printf '%s' "$current" |
  jq -er --arg name "$name" \
    '.[] | select(.session_name == $name)
      | .host_process.process_id
      | select(type == "number" and floor == .)')
host_start_marker=$(printf '%s' "$current" |
  jq -er --arg name "$name" \
    '.[] | select(.session_name == $name)
      | .host_process.start_marker
      | select(type == "string")')
provider_pid=$(printf '%s' "$current" |
  jq -er --arg name "$name" \
    '.[] | select(.session_name == $name)
      | .provider_process.process_id
      | select(type == "number" and floor == .)')
provider_start_marker=$(printf '%s' "$current" |
  jq -er --arg name "$name" \
    '.[] | select(.session_name == $name)
      | .provider_process.start_marker
      | select(type == "string")')
session_generation=$(printf '%s' "$current" |
  jq -cer --arg name "$name" \
    '.[] | select(.session_name == $name)
      | select(
          [
            .workspace_id,
            .runner_principal,
            .runner_instance,
            .channel_epoch,
            .host_instance_id,
            .terminal_epoch
          ] | all(type == "string" and length > 0)
        )
      | {
          workspace_id,
          session_id,
          runner_principal,
          runner_instance,
          channel_epoch,
          host_instance_id,
          terminal_epoch
        }')

send_marker() {
  marker=$1
  write=$(hmux_cmd --json send-keys -t "$name" --literal "printf '$marker\n'")
  enter=$(hmux_cmd --json send-keys -t "$name" Enter)
  printf '%s' "$write" |
    jq -e '.ok == true and .state == "WrittenToPty"' >/dev/null
  printf '%s' "$enter" |
    jq -e '.ok == true and .state == "WrittenToPty"' >/dev/null
}

wait_for_marker() {
  marker=$1
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    recent=$(hmux_cmd --json read --lines 30 "$name")
    if printf '%s' "$recent" |
      jq -e --arg marker "$marker" \
        '.ok == true and (.lines | join("\n") | contains($marker))' \
        >/dev/null; then
      printf '%s' "$recent"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.1
  done
  echo "hmux remote soak: marker did not reach bounded screen state: $marker" >&2
  return 1
}

read_snapshot_sequence() {
  snapshot=$(hmux_cmd --json screen "$name")
  printf '%s' "$snapshot" |
    jq -e \
      '.ok == true and .truncated == false and (.rows > 0) and (.columns > 0)' \
      >/dev/null
  printf '%s' "$snapshot" | jq -er '.sequenceThrough | tonumber'
}

observe_snapshot() {
  output=$1
  marker=$2
  exit_code=0
  timeout -k 1s 2s "$hmux" --discovery-root "$discovery_root" \
    attach --read-only "$name" >"$output" 2>/dev/null ||
    exit_code=$?
  if [ "$exit_code" -ne 124 ]; then
    echo "hmux remote soak: observer exited unexpectedly: $exit_code" >&2
    return 1
  fi
  grep -aF "$marker" "$output" >/dev/null
  kill -0 "$host_pid"
}

marker_one="HMUX_SOAK_ONE_$session_id"
send_marker "$marker_one"
read_one=$(wait_for_marker "$marker_one")
sequence_one=$(read_snapshot_sequence)
observe_snapshot "$attach_one" "$marker_one"

marker_two="HMUX_SOAK_TWO_$session_id"
send_marker "$marker_two"
read_two=$(wait_for_marker "$marker_two")
sequence_two=$(read_snapshot_sequence)
if [ "$sequence_two" -le "$sequence_one" ]; then
  echo \
    "hmux remote soak: snapshot sequence did not increase: $sequence_one -> $sequence_two" \
    >&2
  exit 1
fi
observe_snapshot "$attach_two" "$marker_two"

last_sequence=$sequence_two
iteration=0
while [ "$iteration" -lt "$screen_reads" ]; do
  current_sequence=$(read_snapshot_sequence)
  if [ "$current_sequence" -lt "$last_sequence" ]; then
    echo \
      "hmux remote soak: snapshot sequence regressed: $last_sequence -> $current_sequence" \
      >&2
    exit 1
  fi
  last_sequence=$current_sequence
  iteration=$((iteration + 1))
done

after=$(list_sessions)
if ! printf '%s' "$after" |
  jq -e \
    --arg name "$name" \
    --arg start_marker "$host_start_marker" \
    --argjson host_pid "$host_pid" \
    --arg provider_start_marker "$provider_start_marker" \
    --argjson provider_pid "$provider_pid" \
    --argjson generation "$session_generation" \
    'def generation: {
      workspace_id,
      session_id,
      runner_principal,
      runner_instance,
      channel_epoch,
      host_instance_id,
      terminal_epoch
    };
    length == 1 and .[0].session_name == $name
      and (.[0] | generation) == $generation
      and .[0].host_process.process_id == $host_pid
      and .[0].host_process.start_marker == $start_marker
      and .[0].provider_process.process_id == $provider_pid
      and .[0].provider_process.start_marker == $provider_start_marker
      and .[0].lifecycle == "ready"' >/dev/null; then
  echo "hmux remote soak: temporary Host generation changed" >&2
  exit 1
fi

first_attach_bytes=$(wc -c <"$attach_one" | tr -d ' ')
second_attach_bytes=$(wc -c <"$attach_two" | tr -d ' ')
first_returned_lines=$(printf '%s' "$read_one" | jq '.lines | length')
second_returned_lines=$(printf '%s' "$read_two" | jq '.lines | length')
total_screen_reads=$((screen_reads + 2))

cleanup_owned_state

jq -n \
  --arg sessionId "$session_id" \
  --argjson hostPid "$host_pid" \
  --arg hostStartMarker "$host_start_marker" \
  --argjson sequenceOne "$sequence_one" \
  --argjson sequenceTwo "$sequence_two" \
  --argjson firstAttachBytes "$first_attach_bytes" \
  --argjson secondAttachBytes "$second_attach_bytes" \
  --argjson firstReturnedLines "$first_returned_lines" \
  --argjson secondReturnedLines "$second_returned_lines" \
  --argjson screenReads "$total_screen_reads" \
  '{
    ok: true,
    sessionId: $sessionId,
    hostPid: $hostPid,
    hostStartMarker: $hostStartMarker,
    snapshotSequences: [$sequenceOne, $sequenceTwo],
    screenReads: $screenReads,
    attachBytes: [$firstAttachBytes, $secondAttachBytes],
    returnedLines: [$firstReturnedLines, $secondReturnedLines],
    isolatedDiscovery: true,
    cleanup: true
  }'
REMOTE
