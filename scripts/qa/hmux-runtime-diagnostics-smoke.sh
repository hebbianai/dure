#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
cd "$repo_root"

build_id="0.1.4+runtime-diagnostics-smoke"
HMUX_BUILD_ID="$build_id" cargo build \
  --manifest-path hmux/Cargo.toml \
  --package hmux-cli \
  --package hmux-runtime

target_triple=${CARGO_BUILD_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}
if [ -z "$target_triple" ]; then
  echo "hmux runtime diagnostics smoke: could not determine the Rust target triple" >&2
  exit 1
fi

target_root=${CARGO_TARGET_DIR:-"$repo_root/hmux/target"}
if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  target_root="$target_root/$target_triple"
fi
cli="$target_root/debug/hmux"
runtime="$target_root/debug/hmux-runtime"
if [ ! -x "$cli" ] || [ ! -x "$runtime" ]; then
  echo "hmux runtime diagnostics smoke: required executable is unavailable" >&2
  exit 1
fi

discovery_root=$(mktemp -d "${TMPDIR:-/tmp}/hmux-runtime-diagnostics-smoke.XXXXXX")
session_name="runtime-diagnostics-apparent-freeze"
session_started=false

cleanup() {
  if [ "$session_started" = true ]; then
    env -u HMUX "$cli" --discovery-root "$discovery_root" kill "$session_name" \
      >/dev/null 2>&1 || true
  fi
  case "$discovery_root" in
    "${TMPDIR:-/tmp}"/hmux-runtime-diagnostics-smoke.*) rm -r -- "$discovery_root" ;;
    *) echo "hmux runtime diagnostics smoke: refusing unexpected cleanup target" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

capabilities=$("$cli" capabilities --json)
node -e '
  const value = JSON.parse(process.argv[1]);
  if (
    value.schemaVersion !== 2 ||
    value.buildInfo?.buildId !== process.argv[2] ||
    value.buildInfo?.source !== "hmux_cli" ||
    value.buildInfo?.protocol?.minimum !== "1.0" ||
    value.buildInfo?.protocol?.maximum !== "1.0" ||
    !value.capabilities?.includes("pairing_v1")
  ) {
    throw new Error("public exact build info is incomplete");
  }
' "$capabilities" "$build_id"

env -u HMUX "$cli" \
  --discovery-root "$discovery_root" \
  new \
  --name "$session_name" \
  --runtime "$runtime" \
  -- \
  /bin/sleep 30 \
  >/dev/null
session_started=true

sessions=$(env -u HMUX "$cli" --discovery-root "$discovery_root" --json ls)
identity=$(node -e '
  const sessions = JSON.parse(process.argv[1]);
  const session = sessions.find((candidate) => candidate.session_name === process.argv[2]);
  if (!session) throw new Error("diagnostic fixture session is missing");
  process.stdout.write(`${session.session_id} ${session.workspace_id}`);
' "$sessions" "$session_name")
set -- $identity
session_id=$1
workspace_id=$2

probe=$(env -u HMUX "$cli" \
  --discovery-root "$discovery_root" \
  --json \
  session probe "$session_id" --workspace "$workspace_id")
node -e '
  const value = JSON.parse(process.argv[1]);
  if (!value.ok || value.status !== "healthy") {
    throw new Error("idle provider was not distinguishable from a frozen Host");
  }
' "$probe"

env -u HMUX "$cli" \
  --discovery-root "$discovery_root" \
  read "$session_id" --workspace "$workspace_id" --lines 5 \
  >/dev/null
env -u HMUX "$cli" \
  --discovery-root "$discovery_root" \
  kill "$session_name" \
  >/dev/null
session_started=false

node -e '
  const fs = require("fs");
  const path = require("path");
  const directory = path.join(process.argv[1], ".diagnostics", "runtime-v1");
  const files = fs.readdirSync(directory)
    .filter((name) => name.startsWith("runtime.jsonl"))
    .map((name) => path.join(directory, name));
  if (files.length === 0 || files.length > 4) {
    throw new Error(`unexpected diagnostic file count: ${files.length}`);
  }
  const raw = files.map((file) => fs.readFileSync(file, "utf8")).join("");
  const records = raw.trim().split("\n").filter(Boolean).map(JSON.parse);
  const events = new Set(records.map((record) => record.event));
  for (const event of [
    "host_starting",
    "host_ready",
    "connection_accepted",
    "attach_ready",
    "attach_detached",
    "provider_exit",
  ]) {
    if (!events.has(event)) throw new Error(`missing runtime event: ${event}`);
  }
  if (!records.every((record) =>
    record.schemaVersion === 1 &&
    record.buildInfo?.buildId === process.argv[2] &&
    record.buildInfo?.source === "hmux_runtime" &&
    record.session?.sessionId === process.argv[3] &&
    record.session?.workspaceId === process.argv[4]
  )) {
    throw new Error("runtime diagnostic identity/build fence is incomplete");
  }
  for (const forbidden of [
    "capabilityToken",
    "launchOwnerProof",
    "/bin/sleep",
    "environment",
    "credential",
    "terminalBytes",
  ]) {
    if (raw.includes(forbidden)) throw new Error(`diagnostics leaked ${forbidden}`);
  }
  if ((fs.statSync(directory).mode & 0o777) !== 0o700) {
    throw new Error("diagnostic directory is not owner-only");
  }
  for (const file of files) {
    const stat = fs.statSync(file);
    if ((stat.mode & 0o777) !== 0o600 || stat.size > 256 * 1024) {
      throw new Error(`unsafe or unbounded diagnostic file: ${file}`);
    }
  }
' "$discovery_root" "$build_id" "$session_id" "$workspace_id"

echo "hmux runtime diagnostics smoke: idle provider remained probeable with redacted lifecycle evidence"
