#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd -P
)
bounded_group_runner="$repo_root/scripts/qa/lib/bounded-owned-process-group.mjs"
command_tmp_root=
bounded_group_completion_receipt='{"cleanup":"verified","schema":"dure-qa-bounded-owned-process-group/v1"}'
runner_completion_receipt='{"cleanup":"verified","schema":"dure-qa-tauri-app-runner/v1"}'
active_cancel_file=
cleanup_active=0
ownership_uncertain=0
requested_exit_status=0
wait_interrupted=0

qa_name="Spawn prompt SSH receipt-loss smoke"
lima_version=1.2.1
fixture_root=
lima_home=
lima_host_home=
vm_name=
qa_tmp_root=
guest_root=
direct_timeout=${DURE_QA_SSH_COMMAND_TIMEOUT_SECONDS:-45}
lima_ssh_alias='ssh -o ControlMaster=no -o ControlPersist=no -o ControlPath=none'

cd "$repo_root"

request_exit() {
  wait_interrupted=1
  if [ -n "$active_cancel_file" ]; then
    if (umask 077 && set -C && : >"$active_cancel_file") 2>/dev/null; then
      [ "$requested_exit_status" -ne 0 ] || requested_exit_status=$1
      return 0
    fi
    if [ -f "$active_cancel_file" ]; then
      [ "$requested_exit_status" -ne 0 ] || requested_exit_status=$1
      return 0
    fi
    ownership_uncertain=1
    echo "$qa_name: could not publish child cancellation cancel=$active_cancel_file" >&2
    active_cancel_file=
  fi
  [ "$requested_exit_status" -ne 0 ] || requested_exit_status=$1
  exit "$requested_exit_status"
}

trap 'request_exit 129' HUP
trap 'request_exit 130' INT
trap 'request_exit 143' TERM

create_command_root() {
  command_prefix=$1
  created_command_root=
  if created_command_root=$(mktemp -d \
    "$command_tmp_root/$command_prefix.XXXXXX"); then
    return 0
  fi
  ownership_uncertain=1
  echo "$qa_name: could not allocate a private $command_prefix root" >&2
  return 97
}

bounded_command() {
  bounded_seconds=$1
  shift
  bounded_name=${1##*/}
  create_command_root dure-owned-command || return 97
  bounded_root=$created_command_root
  bounded_descriptor="$bounded_root/group.json"
  bounded_cancel_file="$bounded_root/cancel"
  bounded_receipt="$bounded_root/completion.json"
  active_cancel_file=$bounded_cancel_file
  node "$bounded_group_runner" run \
    "$bounded_root" \
    --timeout-seconds "$bounded_seconds" \
    -- "$@" &
  bounded_runner_pid=$!
  while :; do
    wait_interrupted=0
    if wait "$bounded_runner_pid"; then
      bounded_status=0
    else
      bounded_status=$?
    fi
    [ "$wait_interrupted" -eq 1 ] || break
  done

  bounded_observed_receipt=
  if [ -f "$bounded_receipt" ]; then
    IFS= read -r bounded_observed_receipt <"$bounded_receipt" || true
  fi
  if [ "$bounded_observed_receipt" = "$bounded_group_completion_receipt" ]; then
    active_cancel_file=
    case "$bounded_root" in
      "$command_tmp_root"/dure-owned-command.*)
        if ! rm -r -- "$bounded_root"; then
          echo "$qa_name: could not retire command root $bounded_root" >&2
          [ "$bounded_status" -ne 0 ] || bounded_status=1
        fi
        ;;
      *)
        ownership_uncertain=1
        echo "$qa_name: refusing unexpected command cleanup target: $bounded_root" >&2
        ;;
    esac
  else
    ownership_uncertain=1
    active_cancel_file=
    echo \
      "$qa_name: exact cleanup is uncertain for bounded $bounded_name command_root=$bounded_root descriptor=$bounded_descriptor receipt=$bounded_receipt" \
      >&2
  fi

  if [ "$requested_exit_status" -ne 0 ] && [ "$cleanup_active" -eq 0 ]; then
    exit "$requested_exit_status"
  fi
  if [ "$bounded_status" -eq 124 ]; then
    echo "$qa_name: bounded $bounded_name timed out" >&2
  fi
  return "$bounded_status"
}

run_app_runner() {
  app_timeout_seconds=$1
  shift
  create_command_root dure-app-runner || return 97
  app_root=$created_command_root
  app_cancel_file="$app_root/cancel"
  app_receipt="$app_root/completion.json"
  active_cancel_file=$app_cancel_file
  env \
    DURE_QA_RUNNER_CANCEL_FILE="$app_cancel_file" \
    DURE_QA_RUNNER_TIMEOUT_SECONDS="$app_timeout_seconds" \
    DURE_QA_RUNNER_COMPLETION_RECEIPT="$app_receipt" \
    "$@" &
  app_runner_pid=$!
  while :; do
    wait_interrupted=0
    if wait "$app_runner_pid"; then
      app_status=0
    else
      app_status=$?
    fi
    [ "$wait_interrupted" -eq 1 ] || break
  done

  app_cancel_reason=
  if [ -f "$app_cancel_file" ]; then
    IFS= read -r app_cancel_reason <"$app_cancel_file" || true
  fi
  app_observed_receipt=
  if [ -f "$app_receipt" ]; then
    IFS= read -r app_observed_receipt <"$app_receipt" || true
  fi
  if [ "$app_observed_receipt" = "$runner_completion_receipt" ]; then
    active_cancel_file=
    case "$app_root" in
      "$command_tmp_root"/dure-app-runner.*)
        if ! rm -r -- "$app_root"; then
          echo "$qa_name: could not retire app runner control root $app_root" >&2
          [ "$app_status" -ne 0 ] || app_status=1
        fi
        ;;
      *)
        echo "$qa_name: refusing unexpected app runner cleanup target: $app_root" >&2
        [ "$app_status" -ne 0 ] || app_status=1
        ;;
    esac
  else
    ownership_uncertain=1
    active_cancel_file=
    echo \
      "$qa_name: app runner cleanup is uncertain control_root=$app_root receipt=$app_receipt" \
      >&2
  fi

  if [ "$requested_exit_status" -ne 0 ] && [ "$cleanup_active" -eq 0 ]; then
    exit "$requested_exit_status"
  fi
  if [ "$app_cancel_reason" = timeout ]; then
    echo "$qa_name: app runner timed out" >&2
    return 124
  fi
  return "$app_status"
}

lima() {
  bounded_command 120 env \
    HOME="$lima_host_home" \
    LIMA_HOME="$lima_home" \
    SSH="$lima_ssh_alias" \
    limactl "$@"
}

lima_start() {
  # The isolated Lima lifecycle owns its persistent hostagent after start, so
  # only this transient command releases the inherited-fd-v1 witness.
  bounded_command 630 env \
    HOME="$lima_host_home" \
    LIMA_HOME="$lima_home" \
    SSH="$lima_ssh_alias" \
    sh -c '
      control_socket=$1
      shift
      exec 3>&-
      unset DURE_QA_LIVENESS_WITNESS_FD HEBBIAN_QA_LIVENESS_WITNESS_FD
      status=0
      "$@" || status=$?
      ssh -F /dev/null -S "$control_socket" -O exit lima-control-master \
        >/dev/null 2>&1 || true
      exit "$status"
    ' dure-lima-start "$lima_home/$vm_name/ssh.sock" limactl start "$@"
}

lima_cleanup() {
  bounded_command 45 env \
    HOME="$lima_host_home" \
    LIMA_HOME="$lima_home" \
    SSH="$lima_ssh_alias" \
    limactl "$@"
}

cleanup() {
  status=$?
  trap - EXIT
  trap ':' HUP INT TERM
  cleanup_active=1
  if [ -n "$active_cancel_file" ]; then
    outstanding_cancel_file=$active_cancel_file
    if ! (umask 077 && set -C && : >"$outstanding_cancel_file") 2>/dev/null &&
      [ ! -f "$outstanding_cancel_file" ]; then
      echo "$qa_name: could not publish child cancellation cancel=$outstanding_cancel_file" >&2
    fi
    ownership_uncertain=1
    echo \
      "$qa_name: child cleanup receipt was not observed cancel=$outstanding_cancel_file" \
      >&2
    active_cancel_file=
  fi
  set +e
  cleanup_proven=1
  if [ -n "$vm_name" ]; then
    if [ "$ownership_uncertain" -eq 1 ]; then
      cleanup_proven=0
    elif command -v limactl >/dev/null 2>&1; then
      evidence_root="$fixture_root/guest-evidence"
      mkdir -m 700 "$evidence_root" 2>/dev/null || true
      if lima_cleanup copy --recursive \
        "$vm_name:$guest_root" \
        "$evidence_root" >/dev/null; then
        echo "$qa_name: exported guest evidence to $evidence_root" >&2
      else
        echo "$qa_name: guest evidence export was unavailable" >&2
      fi
      if [ "$ownership_uncertain" -eq 0 ]; then
        lima_cleanup stop --force "$vm_name" >/dev/null || true
      fi
      if [ "$ownership_uncertain" -eq 0 ]; then
        lima_cleanup delete --force "$vm_name" >/dev/null || true
      fi
      if [ "$ownership_uncertain" -eq 1 ]; then
        cleanup_proven=0
      else
        cleanup_vm_list="$fixture_root/cleanup-vms"
        if ! lima_cleanup list -q >"$cleanup_vm_list"; then
          cleanup_proven=0
        elif [ "$ownership_uncertain" -eq 1 ] || [ -s "$cleanup_vm_list" ]; then
          cleanup_proven=0
        fi
      fi
    else
      cleanup_proven=0
    fi
  fi

  if [ "$cleanup_proven" -eq 1 ] && [ "$status" -eq 0 ]; then
    case "$fixture_root" in
      "$qa_tmp_root"/dure-spawn-prompt-ssh.*)
        rm -r -- "$fixture_root" || status=1
        ;;
      *)
        echo "$qa_name: refusing unexpected fixture cleanup target: $fixture_root" >&2
        status=1
        ;;
    esac
  else
    [ "$cleanup_proven" -eq 1 ] || status=1
    echo \
      "$qa_name: preserving fixture root=$fixture_root LIMA_HOME=$lima_home VM=$vm_name" \
      >&2
  fi
  exit "$status"
}

for command in git limactl node pnpm python3 scp ssh ssh-keygen ssh-keyscan; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "$qa_name: missing host command: $command" >&2
    exit 1
  }
done
[ -f "$bounded_group_runner" ] || {
  echo "$qa_name: bounded process runner is missing" >&2
  exit 1
}
lima_template="$repo_root/scripts/qa/hmux-tuf-conformance-lima.yaml"
home_setup="$repo_root/scripts/qa/spawn-prompt-ssh-home-setup.mjs"
guest_setup="$repo_root/scripts/qa/spawn-prompt-ssh-guest-setup.sh"
client="$repo_root/scripts/qa/spawn-prompt-receipt-loss-client.mjs"
runner="$repo_root/scripts/qa/lib/tauri-app-runner.sh"
for file in "$lima_template" "$home_setup" "$guest_setup" "$client" "$runner"; do
  [ -f "$file" ] || {
    echo "$qa_name: required fixture file is missing: $file" >&2
    exit 1
  }
done

# Lima derives Unix socket names below LIMA_HOME. macOS gives applications a
# long per-user TMPDIR, so keep this macOS-only fixture under the short system
# alias instead of inheriting that path into Lima's socket namespace.
qa_tmp_root=/tmp
fixture_root=$(mktemp -d "$qa_tmp_root/dure-spawn-prompt-ssh.XXXXXX")
trap cleanup EXIT
chmod 700 "$fixture_root"
command_tmp_root="$fixture_root/commands"
lima_home="$fixture_root/lima"
lima_host_home="$fixture_root/host-home"
mkdir -m 700 "$command_tmp_root" "$lima_home" "$lima_host_home"
export LIMA_HOME="$lima_home"
guest_root=/tmp/dure-spawn-prompt-ssh.fixture

platform_output="$fixture_root/platform"
bounded_command 15 uname -s >"$platform_output"
IFS= read -r platform_system <"$platform_output" || platform_system=
bounded_command 15 uname -m >"$platform_output"
IFS= read -r platform_machine <"$platform_output" || platform_machine=
rm -f -- "$platform_output"
if [ "$platform_system" != Darwin ] || [ "$platform_machine" != arm64 ]; then
  echo "$qa_name: macOS ARM64 is required" >&2
  exit 1
fi
version_output="$fixture_root/lima-version"
bounded_command 15 limactl --version >"$version_output"
IFS= read -r observed_lima_version <"$version_output" || observed_lima_version=
rm -f -- "$version_output"
if [ "$observed_lima_version" != "limactl version $lima_version" ]; then
  echo "$qa_name: limactl must be exactly $lima_version" >&2
  exit 1
fi

# The desktop bundle must contain the Linux Hmux tree before Tauri starts.
bounded_command 630 pnpm hmux:remote:stage:dev

isolated_vms="$fixture_root/isolated-vms"
if ! lima list -q >"$isolated_vms"; then
  echo "$qa_name: could not inspect the isolated Lima home" >&2
  exit 1
fi
if [ -s "$isolated_vms" ]; then
  echo "$qa_name: isolated Lima home was not empty" >&2
  exit 1
fi

key_path="$fixture_root/id_ed25519"
known_hosts="$fixture_root/known_hosts"
transport_marker="$fixture_root/transport-marker"
bounded_command 30 ssh-keygen \
  -q -t ed25519 -N '' -C dure-ssh-receipt-loss -f "$key_path"
chmod 600 "$key_path"

vm_name=dure-ssh-receipt-loss
lima_start \
  --tty=false \
  --name "$vm_name" \
  --network=vzNAT \
  --cpus 2 \
  --memory 2 \
  --timeout 10m \
  "$lima_template"

guest_user_output="$fixture_root/guest-user"
if ! lima shell --tty=false "$vm_name" id -un >"$guest_user_output"; then
  echo "$qa_name: could not resolve the guest account" >&2
  exit 1
fi
guest_user=$(tr -d '\r\n' <"$guest_user_output")
if ! printf '%s\n' "$guest_user" | grep -Eq '^[A-Za-z_][A-Za-z0-9._-]*$'; then
  echo "$qa_name: guest account is invalid" >&2
  exit 1
fi
control_key_output="$fixture_root/control-host-key"
if ! lima shell --tty=false "$vm_name" \
  sudo cat /etc/ssh/ssh_host_ed25519_key.pub >"$control_key_output"; then
  echo "$qa_name: could not read the guest host key" >&2
  exit 1
fi
control_key=$(awk \
  'NR == 1 && $1 == "ssh-ed25519" { print $1, $2 }' \
  "$control_key_output")
[ -n "$control_key" ] || {
  echo "$qa_name: guest ed25519 host key is unavailable" >&2
  exit 1
}
guest_ip_document="$fixture_root/guest-addresses.json"
if ! lima shell --tty=false "$vm_name" \
  ip -j -4 address show scope global >"$guest_ip_document"; then
  echo "$qa_name: could not inspect guest addresses" >&2
  exit 1
fi
guest_ips="$fixture_root/guest-addresses"
python3 -c '
import ipaddress
import json
import sys

for interface in json.load(sys.stdin):
    for address in interface.get("addr_info", []):
        candidate = ipaddress.IPv4Address(address.get("local", ""))
        if not candidate.is_loopback and not candidate.is_unspecified:
            print(candidate)
' <"$guest_ip_document" >"$guest_ips"
[ -s "$guest_ips" ] || {
  echo "$qa_name: guest has no host-routable IPv4 candidate" >&2
  exit 1
}

guest_ip=
scan_key=
attempt=0
while [ -z "$guest_ip" ] && [ "$attempt" -lt 40 ]; do
  attempt=$((attempt + 1))
  while IFS= read -r candidate; do
    scan="$fixture_root/ssh-keyscan"
    : >"$scan"
    if ! bounded_command 8 ssh-keyscan \
      -T 5 -t ed25519 "$candidate" >"$scan" 2>/dev/null; then
      [ "$ownership_uncertain" -eq 0 ] || exit 1
    fi
    candidate_key=$(awk \
      '$2 == "ssh-ed25519" { print $2, $3; exit }' \
      "$scan")
    if [ -n "$candidate_key" ] && [ "$candidate_key" = "$control_key" ]; then
      guest_ip=$candidate
      scan_key=$candidate_key
      break
    fi
  done <"$guest_ips"
  [ -n "$guest_ip" ] || sleep 0.25
done
[ -n "$guest_ip" ] || {
  echo "$qa_name: direct SSH host key did not match the Lima control plane" >&2
  exit 1
}
umask 077
printf '%s %s\n' "$guest_ip" "$scan_key" >"$known_hosts"
chmod 600 "$known_hosts"

lima shell --tty=false "$vm_name" mkdir -m 700 "$guest_root"
lima shell --tty=false "$vm_name" mkdir -m 700 "$guest_root/incoming"
lima copy "$key_path.pub" "$vm_name:$guest_root/incoming/client.pub"
for provider_file in claude dure-qa-fake-provider-common.sh; do
  lima copy \
    "$repo_root/scripts/qa/fake-provider/$provider_file" \
    "$vm_name:$guest_root/incoming/$provider_file"
done
lima copy "$guest_setup" "$vm_name:$guest_root/incoming/guest-setup.sh"
lima shell --tty=false "$vm_name" \
  bash "$guest_root/incoming/guest-setup.sh" "$guest_root"

ssh_target="$guest_user@$guest_ip"
app_ssh() {
  bounded_command "$direct_timeout" ssh \
    -F /dev/null \
    -T \
    -p 22 \
    -i "$key_path" \
    -o BatchMode=yes \
    -o ConnectTimeout=8 \
    -o IdentitiesOnly=yes \
    -o PasswordAuthentication=no \
    -o ServerAliveCountMax=3 \
    -o ServerAliveInterval=5 \
    -o StrictHostKeyChecking=yes \
    -o "UserKnownHostsFile=$known_hosts" \
    "$ssh_target" "$@"
}
app_ssh \
  "sh -lc 'test \"\$(command -v claude)\" = \"$guest_root/bin/claude\" && \
test \"\$DURE_QA_CAPTURE_DIR\" = \"$guest_root/provider-capture\" && \
test \"\$HEBBIAN_QA_CAPTURE_DIR\" = \"$guest_root/provider-capture\" && \
git -C $guest_root/project rev-parse --verify HEAD >/dev/null'"
printf '%s\n' 'ordinary-scp-auth-ok' >"$transport_marker"
bounded_command "$direct_timeout" scp \
  -O \
  -F /dev/null \
  -P 22 \
  -i "$key_path" \
  -o BatchMode=yes \
  -o ConnectTimeout=8 \
  -o IdentitiesOnly=yes \
  -o PasswordAuthentication=no \
  -o ServerAliveCountMax=3 \
  -o ServerAliveInterval=5 \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$known_hosts" \
  "$transport_marker" "$ssh_target:$guest_root/transport-marker"
observed_transport_marker="$fixture_root/observed-transport-marker"
lima shell --tty=false "$vm_name" \
  cat "$guest_root/transport-marker" >"$observed_transport_marker"
IFS= read -r observed_transport <"$observed_transport_marker" || observed_transport=
if [ "$observed_transport" != ordinary-scp-auth-ok ]; then
  echo "$qa_name: direct SCP proof was not observed through Lima control" >&2
  exit 1
fi

qa_prompt="ssh-receipt-loss-$$-one-shot"
qa_prompt_digest_output="$fixture_root/prompt-digest"
bounded_command 15 node -e '
  const crypto = require("node:crypto");
  process.stdout.write(`sha256:${crypto.createHash("sha256").update(process.argv[1]).digest("hex")}\n`);
' "$qa_prompt" >"$qa_prompt_digest_output"
IFS= read -r qa_prompt_digest <"$qa_prompt_digest_output" || qa_prompt_digest=

# The Vite QA channel is worktree-scoped. Start this isolated run with no
# project records from an earlier app instance.
rm -f -- "$repo_root/qa.log"

run_app_runner "${DURE_QA_APP_TIMEOUT_SECONDS:-900}" \
  DURE_QA_CLIENT="$client" \
  DURE_QA_HOME_SETUP="$home_setup" \
  DURE_QA_NAME="$qa_name" \
  DURE_QA_ARTIFACT_NAME="spawn-prompt-ssh-receipt-loss" \
  DURE_QA_LAYER="control_plane_spawn_ssh_receipt_loss" \
  DURE_QA_UNIQUE_APP_CHANNEL=1 \
  DURE_QA_WINDOW_TITLE="Dure Spawn Prompt SSH Receipt-loss QA" \
  DURE_QA_PROJECT_KIND=ssh \
  DURE_QA_PROJECT="$guest_root/project" \
  DURE_QA_PROMPT="$qa_prompt" \
  DURE_QA_FAIL_PROMPT_SUCCESS_APPEND_ONCE="$qa_prompt_digest" \
  DURE_QA_SSH_HOST="$guest_ip" \
  DURE_QA_SSH_PORT=22 \
  DURE_QA_SSH_USER="$guest_user" \
  DURE_QA_SSH_KEY_SOURCE="$key_path" \
  DURE_QA_SSH_KNOWN_HOSTS_SOURCE="$known_hosts" \
  DURE_QA_PROVIDER_INPUTS_LIMA_VM="$vm_name" \
  DURE_QA_PROVIDER_INPUTS_REMOTE_ROOT="$guest_root/provider-capture" \
  DURE_QA_PROVIDER_INPUTS_LIMA_HOME="$lima_home" \
  sh "$runner"
