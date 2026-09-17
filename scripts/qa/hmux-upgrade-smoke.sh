#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
cd "$repo_root"

target_triple=${CARGO_BUILD_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}
if [ -z "$target_triple" ]; then
  echo "upgrade smoke: could not determine the Rust target triple" >&2
  exit 1
fi
case "$target_triple" in
  *-windows-*)
    echo "upgrade smoke: standalone termination is not available on Windows" >&2
    exit 1
    ;;
esac

discovery_root=$(mktemp -d "${TMPDIR:-/tmp}/hmux-upgrade-smoke.XXXXXX")
cleanup() {
  if [ -x "${cli:-}" ]; then
    "$cli" --discovery-root "$discovery_root" kill upgrade-smoke >/dev/null 2>&1 || true
  fi
  case "$discovery_root" in
    "${TMPDIR:-/tmp}"/hmux-upgrade-smoke.*) rm -r -- "$discovery_root" ;;
    *) echo "upgrade smoke: refusing unexpected cleanup target" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

HMUX_BUILD_ID=0.1.0+upgrade-smoke-source \
  cargo build \
    --manifest-path hmux/Cargo.toml \
    --package hmux-cli \
    --package hmux-runtime

target_root=${CARGO_TARGET_DIR:-"$repo_root/hmux/target"}
if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  target_root="$target_root/$target_triple"
fi
cli="$target_root/debug/hmux"
runtime="$target_root/debug/hmux-runtime"
source_runtime="$discovery_root/source-hmux-runtime"
target_runtime="$discovery_root/target-hmux-runtime"
cp -- "$runtime" "$source_runtime"
chmod 700 "$source_runtime"

HMUX_BUILD_ID=0.1.0+upgrade-smoke-target \
  cargo build \
    --manifest-path hmux/Cargo.toml \
    --package hmux-runtime
cp -- "$runtime" "$target_runtime"
chmod 700 "$target_runtime"

env -u HMUX -u HMUX_SESSION_ID -u HMUX_WORKSPACE_ID \
  "$cli" \
  --discovery-root "$discovery_root" \
  new \
  --name upgrade-smoke \
  --runtime "$source_runtime" \
  -- \
  /bin/sh \
  -c \
  'printf "upgrade-smoke-ready\n"; exec sleep 300' \
  >/dev/null

source_json=$("$cli" --discovery-root "$discovery_root" --json ls)
source_session=$(node -e '
  const sessions = JSON.parse(process.argv[1]);
  if (sessions.length !== 1) process.exit(1);
  process.stdout.write(sessions[0].session_id);
' "$source_json")

if env -u HMUX -u HMUX_SESSION_ID -u HMUX_WORKSPACE_ID \
  "$cli" \
  --discovery-root "$discovery_root" \
  upgrade \
  upgrade-smoke \
  --runtime "$target_runtime" \
  >/dev/null 2>&1
then
  echo "upgrade smoke: unconfirmed live restart was accepted" >&2
  exit 1
fi
if ! "$cli" --discovery-root "$discovery_root" --json session show "$source_session" \
  | node -e '
      let body = "";
      process.stdin.on("data", (chunk) => { body += chunk; });
      process.stdin.on("end", () => {
        const session = JSON.parse(body);
        process.exit(session.lifecycle === "ready" ? 0 : 1);
      });
    '
then
  echo "upgrade smoke: refusal changed the source session" >&2
  exit 1
fi

upgrade_json=$(env -u HMUX -u HMUX_SESSION_ID -u HMUX_WORKSPACE_ID \
  "$cli" \
  --discovery-root "$discovery_root" \
  --json \
  upgrade \
  upgrade-smoke \
  --runtime "$target_runtime" \
  --confirm-restart)
replacement_session=$(node -e '
  const receipt = JSON.parse(process.argv[1]);
  if (
    receipt.outcome !== "rehosted" ||
    receipt.sourceSessionId === receipt.replacementSessionId ||
    receipt.targetBuildId !== "0.1.0+upgrade-smoke-target"
  ) process.exit(1);
  process.stdout.write(receipt.replacementSessionId);
' "$upgrade_json")

if source_after=$(
  "$cli" --discovery-root "$discovery_root" --json session show "$source_session" 2>/dev/null
); then
  node -e '
    const source = JSON.parse(process.argv[1]);
    if (source.lifecycle !== "exited") process.exit(1);
  ' "$source_after" || {
    echo "upgrade smoke: retired source remained ready" >&2
    exit 1
  }
fi
if ! "$cli" --discovery-root "$discovery_root" screen "$replacement_session" \
  | grep -q "upgrade-smoke-ready"
then
  echo "upgrade smoke: replacement canonical screen is not ready" >&2
  exit 1
fi

repeat_json=$(env -u HMUX -u HMUX_SESSION_ID -u HMUX_WORKSPACE_ID \
  "$cli" \
  --discovery-root "$discovery_root" \
  --json \
  upgrade \
  upgrade-smoke \
  --runtime "$target_runtime")
node -e '
  const receipt = JSON.parse(process.argv[1]);
  if (
    receipt.outcome !== "already_current" ||
    receipt.sourceSessionId !== receipt.replacementSessionId
  ) process.exit(1);
' "$repeat_json"

echo "upgrade smoke: confirmation fence, replacement readiness, and repeat no-op passed"
