#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <artifact-stage> <evidence-directory>" >&2
  exit 2
fi

artifact_stage=$1
evidence_directory=$2
expected_source=${HMUX_EXPECTED_SOURCE_COMMIT:-}
screen_reads=${HMUX_LINUX_ARTIFACT_SCREEN_READS:-25}
minimum_soak_seconds=${HMUX_LINUX_ARTIFACT_SOAK_SECONDS:-0}
remote_carrier=${HMUX_LINUX_ARTIFACT_REMOTE_CARRIER:-0}
fault_after_authorization=${HMUX_LINUX_ARTIFACT_FAULT_AFTER_AUTHORIZATION:-0}
requested_run_token=${HMUX_LINUX_ARTIFACT_RUN_TOKEN:-}
lima_version=1.2.1
image_release=20260725
image_digest=2eaec7286c49fdea713dddabcf5012cafa7097a658e916acb48f4bc5fdc8e419

if ! printf '%s\n' "$expected_source" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "hmux Linux artifact VM: HMUX_EXPECTED_SOURCE_COMMIT must be a full commit" >&2
  exit 2
fi
case "$screen_reads" in
  *[!0-9]* | "")
    echo "hmux Linux artifact VM: screen reads must be an integer" >&2
    exit 2
    ;;
esac
if [ "$screen_reads" -lt 1 ] || [ "$screen_reads" -gt 10000 ]; then
  echo "hmux Linux artifact VM: screen reads must be from 1 through 10000" >&2
  exit 2
fi
case "$minimum_soak_seconds" in
  *[!0-9]* | "")
    echo "hmux Linux artifact VM: soak seconds must be an integer" >&2
    exit 2
    ;;
esac
if [ "$minimum_soak_seconds" -gt 1800 ]; then
  echo "hmux Linux artifact VM: soak seconds must be from 0 through 1800" >&2
  exit 2
fi
case "$remote_carrier" in
  0 | 1) ;;
  *)
    echo "hmux Linux artifact VM: remote carrier must be 0 or 1" >&2
    exit 2
    ;;
esac
case "$fault_after_authorization" in
  0 | 1) ;;
  *)
    echo "hmux Linux artifact VM: authorization fault must be 0 or 1" >&2
    exit 2
    ;;
esac
if [ "$fault_after_authorization" -eq 1 ] &&
  [ "$remote_carrier" -ne 1 ]; then
  echo "hmux Linux artifact VM: authorization fault requires remote carrier" >&2
  exit 2
fi
if [ -n "$requested_run_token" ] &&
  ! printf '%s\n' "$requested_run_token" |
    grep -Eq '^[A-Za-z0-9.-]+$'; then
  echo "hmux Linux artifact VM: run token was unsafe" >&2
  exit 2
fi
if [ ! -d "$artifact_stage" ]; then
  echo "hmux Linux artifact VM: artifact stage is missing" >&2
  exit 2
fi
if [ ! -f "$artifact_stage/SHA256SUMS" ]; then
  echo "hmux Linux artifact VM: artifact stage has no SHA256SUMS" >&2
  exit 2
fi
if [ -e "$evidence_directory" ]; then
  echo "hmux Linux artifact VM: evidence directory must not exist" >&2
  exit 2
fi
mkdir -m 700 "$evidence_directory"

current_phase=bootstrap
current_triple=none
vm_name=
client_vm_name=
server_state_prepared=0

write_run_receipt() {
  run_status=$1
  run_exit_code=$2
  run_trigger_exit_code=$3
  run_cleanup_succeeded=$4
  python3 - \
    "$run_status" "$run_exit_code" "$current_phase" "$current_triple" \
    "$expected_source" "$run_trigger_exit_code" \
    "$run_cleanup_succeeded" >"$evidence_directory/run.json.tmp" <<'PY'
import json
import sys

print(json.dumps({
    "ok": sys.argv[1] == "succeeded",
    "status": sys.argv[1],
    "exitCode": int(sys.argv[2]),
    "triggerExitCode": int(sys.argv[6]),
    "cleanupSucceeded": sys.argv[7] == "1",
    "phase": sys.argv[3],
    "targetTriple": None if sys.argv[4] == "none" else sys.argv[4],
    "sourceCommit": sys.argv[5],
    "detailRedacted": True,
}, sort_keys=True, separators=(",", ":")))
PY
  mv "$evidence_directory/run.json.tmp" "$evidence_directory/run.json"
}

bounded_command() {
  bounded_seconds=$1
  shift
  python3 - "$bounded_seconds" "$@" <<'PY'
import os
import pathlib
import signal
import subprocess
import sys

timeout = float(sys.argv[1])
command = sys.argv[2:]
try:
    child = subprocess.Popen(command, start_new_session=True)
except OSError:
    print(
        f"hmux Linux artifact VM: could not launch bounded {pathlib.Path(command[0]).name}",
        file=sys.stderr,
    )
    raise SystemExit(126)


def terminate_group(signal_number):
    try:
        os.killpg(child.pid, signal_number)
    except ProcessLookupError:
        pass


def forward(signal_number, _frame):
    terminate_group(signal_number)
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        terminate_group(signal.SIGKILL)
        child.wait()
    raise SystemExit(128 + signal_number)


signal.signal(signal.SIGINT, forward)
signal.signal(signal.SIGTERM, forward)
try:
    return_code = child.wait(timeout=timeout)
except subprocess.TimeoutExpired:
    terminate_group(signal.SIGTERM)
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        terminate_group(signal.SIGKILL)
        child.wait()
    print(
        f"hmux Linux artifact VM: bounded {pathlib.Path(command[0]).name} timed out",
        file=sys.stderr,
    )
    raise SystemExit(124)
raise SystemExit(
    return_code if return_code >= 0 else 128 + abs(return_code)
)
PY
}

lima_with_timeout() {
  lima_timeout_seconds=$1
  shift
  bounded_command "$lima_timeout_seconds" limactl "$@"
}

lima() {
  lima_with_timeout 120 "$@"
}

lima_start() {
  bounded_command 630 limactl start "$@"
}

lima_cleanup() {
  bounded_command 45 limactl "$@"
}

cleanup_one_vm() {
  cleanup_name=$1
  if [ -z "$cleanup_name" ]; then
    return 0
  fi
  if ! command -v limactl >/dev/null 2>&1; then
    echo "hmux Linux artifact VM: limactl disappeared before exact cleanup" >&2
    return 1
  fi
  lima_cleanup stop --force "$cleanup_name" >/dev/null 2>&1 || true
  lima_cleanup delete --force "$cleanup_name" >/dev/null 2>&1 || true
  if ! vm_list=$(lima_cleanup list -q 2>/dev/null); then
    echo "hmux Linux artifact VM: could not prove exact VM cleanup: $cleanup_name" >&2
    return 1
  fi
  if printf '%s\n' "$vm_list" | grep -Fx "$cleanup_name" >/dev/null; then
    echo "hmux Linux artifact VM: exact VM cleanup was not proven: $cleanup_name" >&2
    return 1
  fi
  return 0
}

cleanup_vms() {
  cleanup_status=0
  cleanup_one_vm "$client_vm_name" || cleanup_status=1
  cleanup_one_vm "$vm_name" || cleanup_status=1
  return "$cleanup_status"
}

recover_failed_server_state() {
  if [ "$server_state_prepared" -ne 1 ] ||
    [ -z "$vm_name" ] ||
    [ "$current_triple" = none ]; then
    return 0
  fi
  failed_triple=$current_triple
  if ! run_phase failure-cleanup "$failed_triple"; then
    echo "hmux Linux artifact VM: failed state cleanup was not proven" >&2
    return 1
  fi
  server_state_prepared=0
}

on_exit() {
  on_exit_trigger_status=$?
  on_exit_final_status=$on_exit_trigger_status
  on_exit_cleanup_succeeded=1
  on_exit_failed_phase=$current_phase
  on_exit_failed_triple=$current_triple
  trap - EXIT HUP INT TERM
  if [ "$on_exit_trigger_status" -ne 0 ] &&
    ! recover_failed_server_state; then
    on_exit_cleanup_succeeded=0
  fi
  if ! cleanup_vms; then
    on_exit_cleanup_succeeded=0
  fi
  current_phase=$on_exit_failed_phase
  current_triple=$on_exit_failed_triple
  find "$evidence_directory" -maxdepth 1 -type f -name '.raw-*' -delete ||
    on_exit_cleanup_succeeded=0
  if [ "$on_exit_cleanup_succeeded" -ne 1 ]; then
    on_exit_final_status=1
  fi
  if [ "$on_exit_trigger_status" -eq 0 ] &&
    [ "$on_exit_cleanup_succeeded" -eq 1 ]; then
    write_run_receipt succeeded 0 0 1 || on_exit_final_status=1
  else
    write_run_receipt failed \
      "$on_exit_final_status" \
      "$on_exit_trigger_status" \
      "$on_exit_cleanup_succeeded" || true
  fi
  exit "$on_exit_final_status"
}
trap on_exit EXIT
trap 'exit 1' HUP INT TERM
write_run_receipt running 0 0 1

for command in limactl python3 shasum; do
  command -v "$command" >/dev/null 2>&1 ||
    {
      echo "hmux Linux artifact VM: missing host command: $command" >&2
      exit 1
    }
done
if [ "$(lima --version)" != "limactl version $lima_version" ]; then
  echo "hmux Linux artifact VM: limactl must be exactly $lima_version" >&2
  exit 1
fi
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "hmux Linux artifact VM: VZ/Rosetta runner must be macOS ARM64" >&2
  exit 1
fi
if ! (
  cd "$artifact_stage"
  shasum -a 256 -c SHA256SUMS >/dev/null
); then
  echo "hmux Linux artifact VM: archive digest verification failed" >&2
  exit 1
fi

script_directory=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
repository_root=$(CDPATH= cd -- "$script_directory/../.." && pwd -P)
lima_template="$script_directory/hmux-linux-artifact-lima.yaml"
probe="$script_directory/hmux-linux-artifact-probe.py"
linux_process_boundary="$repository_root/scripts/native/linux-process-boundary.py"
installer="$repository_root/scripts/install-hmux.sh"
for file in "$lima_template" "$probe" "$linux_process_boundary" "$installer"; do
  [ -f "$file" ] ||
    {
      echo "hmux Linux artifact VM: required file is missing" >&2
      exit 1
    }
done
sha256_file() {
  python3 - "$1" <<'PY'
import hashlib
import pathlib
import sys

print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
}

sha256_text() {
  python3 - "$1" <<'PY'
import hashlib
import sys

print(hashlib.sha256(sys.argv[1].encode()).hexdigest())
PY
}

driver_digest=$(sha256_file "$script_directory/hmux-linux-artifact-lima.sh")
probe_digest=$(sha256_file "$probe")
linux_process_boundary_digest=$(sha256_file "$linux_process_boundary")
installer_digest=$(sha256_file "$installer")
lima_template_digest=$(sha256_file "$lima_template")

if [ -n "$requested_run_token" ]; then
  run_token=$requested_run_token
else
  run_token=${GITHUB_RUN_ID:-manual}-attempt-${GITHUB_RUN_ATTEMPT:-0}-$$
fi
vm_name="hmux-artifact-$run_token"
client_vm_name="$vm_name-client"
guest_root="/tmp/hmux-linux-artifact-$run_token"
for checked_vm_name in "$vm_name" "$client_vm_name"; do
  printf '%s\n' "$checked_vm_name" |
    grep -Eq '^hmux-artifact-[A-Za-z0-9.-]+$' ||
    {
      echo "hmux Linux artifact VM: unsafe VM name" >&2
      exit 1
    }
done
printf '%s\n' "$guest_root" |
  grep -Eq '^/tmp/hmux-linux-artifact-[A-Za-z0-9.-]+$' ||
  {
    echo "hmux Linux artifact VM: unsafe guest root" >&2
    exit 1
  }

failure_receipt() {
  phase=$1
  triple=$2
  status=$3
  error_digest=$4
  python3 - \
    "$phase" "$triple" "$status" "$expected_source" "$error_digest" <<'PY'
import json
import sys

print(json.dumps({
    "ok": False,
    "phase": sys.argv[1],
    "targetTriple": sys.argv[2],
    "exitCode": int(sys.argv[3]),
    "sourceCommit": sys.argv[4],
    "detailRedacted": True,
    "redactedDetailSha256": sys.argv[5],
}, sort_keys=True, separators=(",", ":")))
PY
}

run_phase_on() {
  phase_vm=$1
  phase_state_kind=$2
  phase=$3
  triple=$4
  shift 4
  case "$phase_state_kind" in
    server) state_root="$guest_root/state-$triple" ;;
    client) state_root="$guest_root/state-client-$triple" ;;
    *)
      echo "hmux Linux artifact VM: unsafe phase state kind" >&2
      return 2
      ;;
  esac
  current_phase=$phase
  current_triple=$triple
  phase_lima_timeout_seconds=120
  if [ "$phase" = remote-disconnected-soak ]; then
    phase_lima_timeout_seconds=$((minimum_soak_seconds + 120))
  fi
  receipt="$evidence_directory/$triple-$phase.json"
  raw_error="$evidence_directory/.raw-$triple-$phase.log"
  status=0
  lima_with_timeout "$phase_lima_timeout_seconds" \
    shell --tty=false "$phase_vm" \
    python3 "$guest_root/probe.py" "$phase" \
    --tree "$guest_root/$triple" \
    --triple "$triple" \
    --state-root "$state_root" \
    --expected-source "$expected_source" \
    "$@" >"$receipt.tmp" 2>"$raw_error" ||
    status=$?
  if [ "$status" -ne 0 ]; then
    error_digest=$(sha256_file "$raw_error")
    failure_receipt \
      "$phase" "$triple" "$status" "$error_digest" >"$receipt"
    rm -f "$receipt.tmp"
    rm -f "$raw_error"
    echo "hmux Linux artifact VM: $triple $phase failed; detail was redacted" >&2
    return "$status"
  fi
  mv "$receipt.tmp" "$receipt"
  rm -f "$raw_error"
}

run_phase() {
  phase=$1
  triple=$2
  shift 2
  run_phase_on "$vm_name" server "$phase" "$triple" "$@"
}

run_client_phase() {
  phase=$1
  triple=$2
  shift 2
  run_phase_on "$client_vm_name" client "$phase" "$triple" "$@"
}

transfer_remote_handoff() {
  triple=$1
  current_phase=remote-state-transfer
  current_triple=$triple
  receipt="$evidence_directory/$triple-remote-state-transfer.json"
  raw_error="$evidence_directory/.raw-$triple-remote-state-transfer.log"
  raw_handoff="$evidence_directory/.raw-$triple-remote-handoff.json"
  server_receipt="$evidence_directory/$triple-remote-handoff.json"
  client_handoff="$guest_root/state-client-$triple/remote-handoff.incoming"
  status=0
  (
    handoff_digest=$(
      python3 - "$server_receipt" <<'PY'
import json
import pathlib
import re
import sys

receipt = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
digest = receipt.get("handoffSha256")
if (
    receipt.get("ok") is not True
    or receipt.get("phase") != "remote_handoff"
    or not isinstance(digest, str)
    or re.fullmatch(r"[0-9a-f]{64}", digest) is None
):
    raise SystemExit("server handoff receipt was invalid")
print(digest)
PY
    )
    lima shell --tty=false "$vm_name" \
      cat "$guest_root/state-$triple/remote-handoff.json" >"$raw_handoff"
    actual_handoff_digest=$(sha256_file "$raw_handoff")
    if [ "$actual_handoff_digest" != "$handoff_digest" ]; then
      echo "remote handoff changed before client transfer" >&2
      exit 1
    fi
    lima copy "$raw_handoff" "$client_vm_name:$client_handoff"
    python3 - "$triple" "$expected_source" "$handoff_digest" >"$receipt.tmp" <<'PY'
import json
import sys

print(json.dumps({
    "ok": True,
    "phase": "remote_state_transfer",
    "targetTriple": sys.argv[1],
    "sourceCommit": sys.argv[2],
    "handoffSha256": sys.argv[3],
    "topology": "two_vm_user_v2",
    "detailRedacted": True,
}, sort_keys=True, separators=(",", ":")))
PY
  ) 2>"$raw_error" || status=$?
  if [ "$status" -ne 0 ]; then
    error_digest=$(sha256_file "$raw_error")
    failure_receipt \
      remote-state-transfer "$triple" "$status" "$error_digest" >"$receipt"
    rm -f "$receipt.tmp" "$raw_error" "$raw_handoff"
    echo "hmux Linux artifact VM: $triple state transfer failed; detail was redacted" >&2
    return "$status"
  fi
  mv "$receipt.tmp" "$receipt"
  rm -f "$raw_error" "$raw_handoff"
}

if [ "$remote_carrier" -eq 1 ]; then
  lima_start --tty=false \
    --name "$vm_name" \
    --network=lima:user-v2 \
    --timeout 10m \
    "$lima_template"
  lima_start --tty=false \
    --name "$client_vm_name" \
    --network=lima:user-v2 \
    --cpus 2 \
    --memory 2 \
    --timeout 10m \
    "$lima_template"
else
  lima_start --tty=false \
    --name "$vm_name" \
    --timeout 10m \
    "$lima_template"
fi
lima shell --tty=false "$vm_name" mkdir -m 700 "$guest_root"
lima copy "$probe" "$vm_name:$guest_root/probe.py"
lima copy "$linux_process_boundary" "$vm_name:$guest_root/linux-process-boundary.py"
lima copy "$installer" "$vm_name:$guest_root/install-hmux.sh"
server_boot_id=$(
  lima shell --tty=false "$vm_name" \
    cat /proc/sys/kernel/random/boot_id
)
if ! printf '%s\n' "$server_boot_id" |
  grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; then
  echo "hmux Linux artifact VM: server boot identity was unsafe" >&2
  exit 1
fi
server_boot_digest=$(sha256_text "$server_boot_id")
current_phase=process-boundary-stress
current_triple=native
process_boundary_receipt="$evidence_directory/linux-process-boundary-stress.json"
process_boundary_error="$evidence_directory/.raw-linux-process-boundary-stress.log"
process_boundary_status=0
lima_with_timeout 300 shell --tty=false "$vm_name" \
  python3 "$guest_root/linux-process-boundary.py" stress 1000 \
  >"$process_boundary_receipt.tmp" 2>"$process_boundary_error" ||
  process_boundary_status=$?
if [ "$process_boundary_status" -ne 0 ]; then
  process_boundary_error_digest=$(sha256_file "$process_boundary_error")
  failure_receipt \
    "$current_phase" "$current_triple" "$process_boundary_status" \
    "$process_boundary_error_digest" >"$process_boundary_receipt"
  rm -f "$process_boundary_receipt.tmp" "$process_boundary_error"
  echo "hmux Linux artifact VM: process-boundary stress failed; detail was redacted" >&2
  exit "$process_boundary_status"
fi
mv "$process_boundary_receipt.tmp" "$process_boundary_receipt"
rm -f "$process_boundary_error"
server_host_public_key_raw=$(
  lima shell --tty=false "$vm_name" \
    cat /etc/ssh/ssh_host_ed25519_key.pub
)
server_host_public_key=$(
  printf '%s\n' "$server_host_public_key_raw" |
    awk 'NR == 1 && NF >= 2 && $1 == "ssh-ed25519" {
           print $1 " " $2
           valid = 1
         }
         END { exit !(NR == 1 && valid) }'
)
client_boot_digest=
if [ "$remote_carrier" -eq 1 ]; then
  lima shell --tty=false "$client_vm_name" mkdir -m 700 "$guest_root"
  lima copy "$probe" "$client_vm_name:$guest_root/probe.py"
  client_boot_id=$(
    lima shell --tty=false "$client_vm_name" \
      cat /proc/sys/kernel/random/boot_id
  )
  if ! printf '%s\n' "$client_boot_id" |
    grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; then
    echo "hmux Linux artifact VM: client boot identity was unsafe" >&2
    exit 1
  fi
  if [ "$client_boot_id" = "$server_boot_id" ]; then
    echo "hmux Linux artifact VM: two endpoints share one boot identity" >&2
    exit 1
  fi
  client_boot_digest=$(sha256_text "$client_boot_id")
fi

x86_archive_digest=
arm_archive_digest=
for triple in x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
  archive=$(
    find "$artifact_stage" -maxdepth 1 -type f \
      -name "*.$triple.release.tar.gz" -print
  )
  if [ -z "$archive" ] || [ "$(printf '%s\n' "$archive" | wc -l | tr -d ' ')" -ne 1 ]; then
    echo "hmux Linux artifact VM: expected exactly one archive for $triple" >&2
    exit 1
  fi
  archive_name=$(basename "$archive")
  archive_digest=$(sha256_file "$archive")
  declared_digest=$(
    awk -v name="$archive_name" '$2 == name { print $1 }' \
      "$artifact_stage/SHA256SUMS"
  )
  if ! printf '%s\n' "$declared_digest" |
    grep -Eq '^[0-9a-f]{64}$' ||
    [ "$declared_digest" != "$archive_digest" ]; then
    echo "hmux Linux artifact VM: archive digest is not bound by SHA256SUMS" >&2
    exit 1
  fi
  case "$triple" in
    x86_64-unknown-linux-musl) x86_archive_digest=$archive_digest ;;
    aarch64-unknown-linux-musl) arm_archive_digest=$archive_digest ;;
  esac
  guest_archive="$guest_root/$triple.tar.gz"
  lima copy "$archive" "$vm_name:$guest_archive"
  lima shell --tty=false "$vm_name" tar -xzf "$guest_archive" -C "$guest_root"
  if [ "$remote_carrier" -eq 1 ]; then
    lima copy "$archive" "$client_vm_name:$guest_archive"
    lima shell --tty=false "$client_vm_name" \
      tar -xzf "$guest_archive" -C "$guest_root"
  fi

  # These are separate SSH sessions. A Host that was coupled to the carrier
  # disappears between the two calls and makes resume fail.
  server_state_prepared=1
  run_phase prepare "$triple"
  run_phase structured-attach "$triple"
  local_soak_seconds=$minimum_soak_seconds
  if [ "$remote_carrier" -eq 1 ]; then
    local_soak_seconds=0
  fi
  run_phase resume "$triple" \
    --screen-reads "$screen_reads" \
    --minimum-soak-seconds "$local_soak_seconds"
  run_phase pairing "$triple"
  if [ "$remote_carrier" -eq 1 ]; then
    remote_host="lima-$vm_name.internal"
    case "$remote_host" in
      localhost | 127.* | ::1)
        echo "hmux Linux artifact VM: remote endpoint must not be loopback" >&2
        exit 1
        ;;
    esac
    run_client_phase remote-client-prepare "$triple" \
      --remote-host "$remote_host" \
      --expected-host-public-key "$server_host_public_key"
    remote_public_key=$(
      lima shell --tty=false "$client_vm_name" \
        cat "$guest_root/state-client-$triple/remote-client-key.pub"
    )
    if ! printf '%s\n' "$remote_public_key" |
      awk 'NR == 1 && NF == 2 && $1 == "ssh-ed25519" { valid = 1 }
           END { exit !(NR == 1 && valid) }'; then
      echo "hmux Linux artifact VM: client public key was not exact" >&2
      exit 1
    fi
    remote_user=$(lima shell --tty=false "$vm_name" id -un)
    if ! printf '%s\n' "$remote_user" |
      grep -Eq '^[A-Za-z_][A-Za-z0-9_.-]*$'; then
      echo "hmux Linux artifact VM: remote user was unsafe" >&2
      exit 1
    fi
    if [ "$fault_after_authorization" -eq 1 ]; then
      run_phase authorize-remote "$triple" \
        --remote-host "$remote_host" \
        --remote-public-key "$remote_public_key" \
        --fault-after-authorization-install
    else
      run_phase authorize-remote "$triple" \
        --remote-host "$remote_host" \
        --remote-public-key "$remote_public_key"
    fi
    run_phase remote-handoff "$triple"
    transfer_remote_handoff "$triple"
    handoff_digest=$(
      python3 - \
        "$evidence_directory/$triple-remote-handoff.json" \
        "$evidence_directory/$triple-remote-state-transfer.json" \
        "$expected_source" <<'PY'
import json
import pathlib
import re
import sys

handoff = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
transfer = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
digest = handoff.get("handoffSha256")
if (
    handoff.get("ok") is not True
    or transfer.get("ok") is not True
    or transfer.get("sourceCommit") != sys.argv[3]
    or transfer.get("handoffSha256") != digest
    or not isinstance(digest, str)
    or re.fullmatch(r"[0-9a-f]{64}", digest) is None
):
    raise SystemExit("remote handoff receipts disagreed before import")
print(digest)
PY
    )
    run_client_phase remote-state-import "$triple" \
      --handoff-path "$guest_root/state-client-$triple/remote-handoff.incoming" \
      --handoff-sha256 "$handoff_digest"
    run_client_phase remote-open "$triple" \
      --remote-host "$remote_host" \
      --remote-user "$remote_user"
    run_phase remote-disconnected-soak "$triple" \
      --minimum-soak-seconds "$minimum_soak_seconds"
    run_phase remote-marker "$triple"
    run_client_phase remote-resume "$triple" \
      --remote-host "$remote_host" \
      --remote-user "$remote_user"
    run_phase revoke-remote "$triple"
    run_client_phase remote-rejected "$triple" \
      --remote-host "$remote_host" \
      --remote-user "$remote_user"
  fi
  run_phase activation "$triple" --installer "$guest_root/install-hmux.sh"
  run_phase cleanup "$triple"
  server_state_prepared=0
done

# A green summary is authoritative only after the exact server/client census
# proves both VM resources absent. Failure before this boundary leaves only
# phase receipts plus the failed run receipt written by the EXIT handler.
cleanup_vms
vm_name=
client_vm_name=

python3 - \
  "$expected_source" \
  "$screen_reads" \
  "$minimum_soak_seconds" \
  "$remote_carrier" \
  "$lima_version" \
  "$image_release" \
  "$image_digest" \
  "$x86_archive_digest" \
  "$arm_archive_digest" \
  "$driver_digest" \
  "$probe_digest" \
  "$installer_digest" \
  "$lima_template_digest" \
  "$server_boot_digest" \
  "$client_boot_digest" \
  "$evidence_directory" \
  "$linux_process_boundary_digest" >"$evidence_directory/summary.json" <<'PY'
import json
import pathlib
import re
import sys

remote_carrier = sys.argv[4] == "1"
evidence = pathlib.Path(sys.argv[16])
process_boundary = json.loads(
    (evidence / "linux-process-boundary-stress.json").read_text(encoding="utf-8")
)
if process_boundary != {
    "escapedDescendants": 0,
    "iterations": 1000,
    "pidReuseRefused": True,
    "schema": "dure-linux-process-boundary-stress/v1",
    "sentinelSignals": 0,
    "signalAuthority": "pidfd-plus-start-ticks",
    "subreaper": True,
}:
    raise SystemExit("Linux process-boundary stress evidence was incomplete")
triples = (
    "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-musl",
)


def read_receipt(triple, file_phase, receipt_phase, build_id):
    receipt = json.loads(
        (evidence / f"{triple}-{file_phase}.json").read_text(encoding="utf-8")
    )
    if (
        receipt.get("ok") is not True
        or receipt.get("phase") != receipt_phase
        or receipt.get("targetTriple") != triple
        or (build_id is not None and receipt.get("buildId") != build_id)
    ):
        raise SystemExit(f"invalid {file_phase} receipt for {triple}")
    return receipt


structured_capabilities = {
    "terminal_state_binary_v1",
    "terminal_viewport_projection_v1",
    "terminal_input_intent_v1",
    "terminal_viewport_wheel_v1",
    "terminal_viewport_multipart_v1",
}
build_ids = {}
structured_observations = {}
for triple in triples:
    prepare = read_receipt(triple, "prepare", "prepare", None)
    if prepare.get("sourceCommit") != sys.argv[1]:
        raise SystemExit(f"prepare source identity changed for {triple}")
    build_ids[triple] = prepare.get("buildId")
    if not isinstance(build_ids[triple], str) or not build_ids[triple]:
        raise SystemExit(f"prepare build identity was missing for {triple}")
    build_id = build_ids[triple]
    structured = read_receipt(
        triple, "structured-attach", "structured_attach", build_id
    )
    resumed_locally = read_receipt(
        triple, "resume", "resume", build_id
    )
    pairing = read_receipt(
        triple, "pairing", "pairing", build_id
    )
    activation = read_receipt(
        triple, "activation", "activation", build_id
    )
    cleanup = read_receipt(
        triple, "cleanup", "cleanup", build_id
    )
    if (
        structured.get("productProfile") != "structured-terminal-v1"
        or structured.get("initialStructuredViewport") is not True
        or structured.get("viewportRecordKind")
        not in ("viewport_frame", "viewport_frame_part")
        or structured.get("recordIdNonzero") is not True
        or not isinstance(structured.get("selectedStructuredCapabilities"), list)
        or any(
            not isinstance(capability, str)
            for capability in structured["selectedStructuredCapabilities"]
        )
        or len(structured["selectedStructuredCapabilities"])
        != len(set(structured["selectedStructuredCapabilities"]))
        or set(structured["selectedStructuredCapabilities"])
        != structured_capabilities
        or resumed_locally.get("carrierReconnected") is not True
        or resumed_locally.get("observerDetached") is not True
        or resumed_locally.get("screenReads") != int(sys.argv[2]) + 1
        or pairing.get("provenRequestAccepted") is not True
        or pairing.get("provenResponseAccepted") is not True
        or pairing.get("authenticatedEndpointUsed") is not True
        or pairing.get("realSshdForcedCommand") is not True
        or pairing.get("revokedCredentialRejected") is not True
        or activation.get("digestPinned") is not True
        or activation.get("exactArtifactInstalled") is not True
        or activation.get("syntheticPointerRollback") is not True
        or activation.get("failedCandidateRejected") is not True
        or activation.get("failedCandidatePreservedPointer") is not True
        or activation.get("exactArtifactReactivated") is not True
        or cleanup.get("generationFenced") is not True
        or cleanup.get("hostExited") is not True
        or cleanup.get("providerExited") is not True
    ):
        raise SystemExit(f"incomplete local artifact evidence for {triple}")
    structured_observations[triple] = {
        "initialViewport": True,
        "productProfile": structured["productProfile"],
        "recordKind": structured["viewportRecordKind"],
        "selectedCapabilities": sorted(
            structured["selectedStructuredCapabilities"]
        ),
    }

remote_observations = {}
if remote_carrier:
    for triple in triples:
        build_id = build_ids[triple]
        client_prepare = read_receipt(
            triple,
            "remote-client-prepare",
            "remote_client_prepare",
            build_id,
        )
        authorize = read_receipt(
            triple, "authorize-remote", "authorize_remote", build_id
        )
        handoff = read_receipt(
            triple, "remote-handoff", "remote_handoff", build_id
        )
        transfer = read_receipt(
            triple,
            "remote-state-transfer",
            "remote_state_transfer",
            None,
        )
        imported = read_receipt(
            triple,
            "remote-state-import",
            "remote_state_import",
            build_id,
        )
        opened = read_receipt(
            triple, "remote-open", "remote_open", build_id
        )
        soak = read_receipt(
            triple,
            "remote-disconnected-soak",
            "remote_disconnected_soak",
            build_id,
        )
        marker = read_receipt(
            triple, "remote-marker", "remote_marker", build_id
        )
        resumed = read_receipt(
            triple, "remote-resume", "remote_resume", build_id
        )
        revoked = read_receipt(
            triple, "revoke-remote", "revoke_remote", build_id
        )
        rejected = read_receipt(
            triple, "remote-rejected", "remote_rejected", build_id
        )
        if any(
            receipt.get("topology") != "two_vm_user_v2"
            for receipt in (
                client_prepare,
                authorize,
                handoff,
                transfer,
                imported,
                opened,
                soak,
                marker,
                resumed,
                revoked,
                rejected,
            )
        ):
            raise SystemExit(f"remote topology changed for {triple}")
        digest = handoff.get("handoffSha256")
        if (
            not isinstance(digest, str)
            or re.fullmatch(r"[0-9a-f]{64}", digest) is None
            or transfer.get("sourceCommit") != sys.argv[1]
            or transfer.get("handoffSha256") != digest
            or imported.get("handoffSha256") != digest
            or imported.get("atomicImport") is not True
            or client_prepare.get("hostKeyAlgorithm") != "ssh-ed25519"
            or re.fullmatch(
                r"SHA256:[A-Za-z0-9+/]{43}",
                client_prepare.get("hostKeyFingerprint", ""),
            )
            is None
            or re.fullmatch(
                r"[0-9a-f]{64}",
                client_prepare.get("knownHostKeySha256", ""),
            )
            is None
            or authorize.get("rollbackJournalPersistedBeforeInstall") is not True
            or authorize.get("forcedCommandInstalled") is not True
            or opened.get("carrierDroppedWithoutDetach") is not True
            or soak.get("carrierState") != "client_ssh_process_terminated"
            or soak.get("hostAndProviderAlive") is not True
            or marker.get("hostAndProviderAlive") is not True
            or resumed.get("cursorResumeWithoutSnapshot") is not True
            or revoked.get("ownedEntryRemoved") is not True
            or revoked.get("authorizedKeysBytesOwnerModeRestored") is not True
            or rejected.get("sameSshdReachableAfterRevocation") is not True
            or rejected.get("revokedCredentialRejected") is not True
        ):
            raise SystemExit(f"incomplete remote carrier evidence for {triple}")
        observed_millis = soak.get("remoteCarrierDisconnectedMsObserved")
        if (
            not isinstance(observed_millis, int)
            or observed_millis < int(sys.argv[3]) * 1_000
            or not isinstance(soak.get("livenessChecks"), int)
            or soak["livenessChecks"] < 1
        ):
            raise SystemExit(f"short remote carrier observation for {triple}")
        remote_observations[triple] = {
            "carrierDisconnectedMsObserved": observed_millis,
            "dropResumeCount": 1,
            "livenessChecks": soak.get("livenessChecks"),
        }

document = {
    "ok": True,
    "sourceCommit": sys.argv[1],
    "screenReadBudgetPerTarget": int(sys.argv[2]),
    "minimumSoakSecondsPerTarget": int(sys.argv[3]),
    "remoteCarrierDisconnectedSecondsRequestedPerTarget": (
        int(sys.argv[3]) if remote_carrier else 0
    ),
    "carrierTopology": (
        "two_vm_user_v2" if remote_carrier else "single_vm_loopback"
    ),
    "remoteObservations": remote_observations,
    "structuredTerminal": structured_observations,
    "hardProcessContainment": process_boundary,
    "targets": {
        "x86_64-unknown-linux-musl": {"archiveSha256": sys.argv[8]},
        "aarch64-unknown-linux-musl": {"archiveSha256": sys.argv[9]},
    },
    "linuxEnvironment": {
        "distribution": "Ubuntu 24.04",
        "imageRelease": sys.argv[6],
        "imageSha256": sys.argv[7],
        "limaVersion": sys.argv[5],
        "nativeArchitecture": "aarch64",
        "x86Execution": "rosetta-binfmt",
        "cpus": 4,
        "memoryGiB": 4,
        "diskGiB": 20,
    },
    "endpointIdentitySha256": {
        "server": sys.argv[14],
        "client": sys.argv[15] if remote_carrier else None,
    },
    "carrierReconnect": (
        "two_vm_ssh_drop_resume"
        if remote_carrier
        else "separate_limactl_ssh_sessions"
    ),
    "harness": {
        "driverSha256": sys.argv[10],
        "probeSha256": sys.argv[11],
        "linuxProcessBoundarySha256": sys.argv[17],
        "installerSha256": sys.argv[12],
        "limaTemplateSha256": sys.argv[13],
    },
    "failureDetailRedacted": True,
}
if remote_carrier:
    document["remoteClientEnvironment"] = {
        "cpus": 2,
        "memoryGiB": 2,
        "diskGiB": 20,
        "network": "lima:user-v2",
    }
print(json.dumps(document, sort_keys=True, separators=(",", ":")))
PY

current_phase=complete
current_triple=none
write_run_receipt succeeded 0 0 1
trap - EXIT HUP INT TERM
echo "Hmux Linux artifacts executed in pinned Linux: $evidence_directory"
