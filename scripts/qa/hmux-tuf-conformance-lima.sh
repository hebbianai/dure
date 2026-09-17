#!/bin/sh
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <repository> <conformance-repository> <rust-archive> <evidence-directory>" >&2
  exit 2
fi

repository=$1
conformance_repository=$2
rust_archive=$3
evidence_directory=$4
expected_source=${HMUX_EXPECTED_SOURCE_COMMIT:-}
conformance_commit=51ee32b3a7cee80d4f998b164357d7c78fe7c541
lima_version=1.2.1
rust_digest=024918027c349bd237617a8a1207d7c4462f70549a31e8bf6c14b0601cfd489e
current_phase=bootstrap
vm_name=
guest_root=
host_temp=
evidence_copied=false

if ! printf '%s\n' "$expected_source" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "hmux TUF Linux conformance: expected source commit must be full" >&2
  exit 2
fi
for directory in "$repository" "$conformance_repository"; do
  [ "$(git -C "$directory" rev-parse --is-inside-work-tree 2>/dev/null)" = true ] ||
    {
    echo "hmux TUF Linux conformance: Git checkout is missing" >&2
    exit 2
    }
done
[ -f "$rust_archive" ] || {
  echo "hmux TUF Linux conformance: Rust archive is missing" >&2
  exit 2
}
[ ! -e "$evidence_directory" ] || {
  echo "hmux TUF Linux conformance: evidence directory must not exist" >&2
  exit 2
}
mkdir -m 700 "$evidence_directory"

write_run_receipt() {
  run_status=$1
  exit_code=$2
  python3 - "$run_status" "$exit_code" "$current_phase" \
    "$expected_source" "$conformance_commit" >"$evidence_directory/run.json.tmp" <<'PY'
import json
import sys

print(json.dumps({
    "ok": sys.argv[1] == "succeeded",
    "status": sys.argv[1],
    "exitCode": int(sys.argv[2]),
    "phase": sys.argv[3],
    "sourceCommit": sys.argv[4],
    "conformanceCommit": sys.argv[5],
    "detailRedacted": True,
}, sort_keys=True, separators=(",", ":")))
PY
  mv "$evidence_directory/run.json.tmp" "$evidence_directory/run.json"
}

copy_guest_evidence() {
  if [ -z "$vm_name" ] || [ -z "$guest_root" ]; then
    return 1
  fi
  if ! limactl shell --tty=false "$vm_name" \
    test -d "$guest_root/evidence" >/dev/null 2>&1; then
    return 1
  fi
  limactl copy --recursive \
    "$vm_name:$guest_root/evidence" "$evidence_directory"
  evidence_copied=true
}

cleanup_vm() {
  if [ -z "$vm_name" ]; then
    return 0
  fi
  if ! command -v limactl >/dev/null 2>&1; then
    echo "hmux TUF Linux conformance: limactl disappeared before cleanup" >&2
    return 1
  fi
  limactl stop --force "$vm_name" >/dev/null 2>&1 || true
  limactl delete --force "$vm_name" >/dev/null 2>&1 || true
  if ! vm_list=$(limactl list -q 2>/dev/null); then
    echo "hmux TUF Linux conformance: could not prove exact VM cleanup" >&2
    return 1
  fi
  if printf '%s\n' "$vm_list" | grep -Fx "$vm_name" >/dev/null; then
    echo "hmux TUF Linux conformance: exact VM cleanup failed" >&2
    return 1
  fi
}

cleanup_host_temp() {
  [ -z "$host_temp" ] && return 0
  case "$(basename "$host_temp")" in
    hmux-tuf-conformance.*) rm -rf -- "$host_temp" ;;
    *)
      echo "hmux TUF Linux conformance: unsafe temporary path" >&2
      return 1
      ;;
  esac
}

on_exit() {
  exit_code=$?
  trap - EXIT HUP INT TERM
  if [ "$evidence_copied" != true ]; then
    copy_guest_evidence >/dev/null 2>&1 || true
  fi
  if ! cleanup_vm; then
    exit_code=1
  fi
  if ! cleanup_host_temp; then
    exit_code=1
  fi
  find "$evidence_directory" -maxdepth 1 -type f -name '.raw-*.log' -delete ||
    exit_code=1
  if [ "$exit_code" -eq 0 ]; then
    write_run_receipt succeeded 0 || exit_code=1
  else
    write_run_receipt failed "$exit_code" || true
  fi
  exit "$exit_code"
}
trap on_exit EXIT
trap 'exit 1' HUP INT TERM
write_run_receipt running 0

for command in git limactl python3 shasum; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "hmux TUF Linux conformance: missing host command: $command" >&2
    exit 1
  }
done
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || {
  echo "hmux TUF Linux conformance: host must be macOS ARM64" >&2
  exit 1
}
[ "$(limactl --version)" = "limactl version $lima_version" ] || {
  echo "hmux TUF Linux conformance: unexpected Lima version" >&2
  exit 1
}
[ "$(git -C "$repository" rev-parse HEAD)" = "$expected_source" ] || {
  echo "hmux TUF Linux conformance: source checkout mismatch" >&2
  exit 1
}
[ "$(git -C "$conformance_repository" rev-parse HEAD)" = "$conformance_commit" ] ||
  {
    echo "hmux TUF Linux conformance: upstream checkout mismatch" >&2
    exit 1
  }
[ "$(shasum -a 256 "$rust_archive" | cut -d ' ' -f 1)" = "$rust_digest" ] ||
  {
    echo "hmux TUF Linux conformance: Rust archive digest mismatch" >&2
    exit 1
  }

script_directory=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
lima_template=$script_directory/hmux-tuf-conformance-lima.yaml
guest_driver=$script_directory/hmux-tuf-conformance-guest.sh
audit=$script_directory/hmux-tuf-conformance-audit.py
requirements=$script_directory/hmux-tuf-conformance-requirements.txt
xfails=$script_directory/hmux-tuf-conformance.xfails
for file in "$lima_template" "$guest_driver" "$audit" "$requirements" "$xfails"; do
  [ -f "$file" ] || {
    echo "hmux TUF Linux conformance: required file is missing" >&2
    exit 1
  }
done

host_temp=$(mktemp -d "${TMPDIR:-/tmp}/hmux-tuf-conformance.XXXXXX")
git -C "$repository" archive --format=tar \
  --output="$host_temp/source.tar" "$expected_source"
git -C "$conformance_repository" archive --format=tar \
  --output="$host_temp/conformance.tar" "$conformance_commit"

run_token=${GITHUB_RUN_ID:-manual}-attempt-${GITHUB_RUN_ATTEMPT:-0}-$$
vm_name=hmux-tuf-$run_token
guest_root=/tmp/hmux-tuf-conformance-$run_token
printf '%s\n' "$vm_name" | grep -Eq '^hmux-tuf-[A-Za-z0-9.-]+$'
printf '%s\n' "$guest_root" |
  grep -Eq '^/tmp/hmux-tuf-conformance-[A-Za-z0-9.-]+$'

current_phase=vm
limactl start --tty=false --name "$vm_name" --timeout 10m "$lima_template"
limactl shell --tty=false "$vm_name" mkdir -m 700 "$guest_root"
limactl shell --tty=false "$vm_name" mkdir -m 700 "$guest_root/incoming"
limactl copy "$host_temp/source.tar" \
  "$vm_name:$guest_root/incoming/source.tar"
limactl copy "$host_temp/conformance.tar" \
  "$vm_name:$guest_root/incoming/conformance.tar"
limactl copy "$rust_archive" \
  "$vm_name:$guest_root/incoming/rust.tar.xz"
limactl copy "$requirements" \
  "$vm_name:$guest_root/incoming/requirements.txt"
limactl copy "$xfails" "$vm_name:$guest_root/incoming/client.xfails"
limactl copy "$audit" "$vm_name:$guest_root/incoming/audit.py"
limactl copy "$guest_driver" "$vm_name:$guest_root/guest.sh"

current_phase=guest
raw_log=$evidence_directory/.raw-guest.log
guest_status=0
limactl shell --tty=false "$vm_name" \
  bash "$guest_root/guest.sh" \
  "$guest_root" "$expected_source" "$conformance_commit" \
  >"$raw_log" 2>&1 || guest_status=$?
if [ "$guest_status" -ne 0 ]; then
  error_digest=$(shasum -a 256 "$raw_log" | cut -d ' ' -f 1)
  python3 - "$guest_status" "$error_digest" \
    >"$evidence_directory/host-failure.json" <<'PY'
import json
import sys

print(json.dumps({
    "ok": False,
    "phase": "guest",
    "exitCode": int(sys.argv[1]),
    "detailRedacted": True,
    "redactedDetailSha256": sys.argv[2],
}, sort_keys=True, separators=(",", ":")))
PY
  rm -f "$raw_log"
  exit "$guest_status"
fi
rm -f "$raw_log"

current_phase=evidence
copy_guest_evidence
[ -f "$evidence_directory/evidence/conformance-summary.json" ] || {
  echo "hmux TUF Linux conformance: summary evidence is missing" >&2
  exit 1
}
