#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
cd "$repo_root"

target_triple=${CARGO_BUILD_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}
if [ -z "$target_triple" ]; then
  echo "legacy kill smoke: could not determine the Rust target triple" >&2
  exit 1
fi

cargo build \
  --manifest-path hmux/Cargo.toml \
  --package hmux-cli \
  --package hmux-runtime

target_root=${CARGO_TARGET_DIR:-"$repo_root/hmux/target"}
if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  target_root="$target_root/$target_triple"
fi
binary_suffix=
case "$target_triple" in
  *-windows-*)
    echo "legacy kill smoke: verified Unix process termination is not available on Windows" >&2
    exit 1
    ;;
esac

cli="$target_root/debug/hmux$binary_suffix"
runtime="$target_root/debug/hmux-runtime$binary_suffix"
python=$(command -v python3)
if [ ! -x "$cli" ] || [ ! -x "$runtime" ] || [ ! -x "$python" ]; then
  echo "legacy kill smoke: required executable is unavailable" >&2
  exit 1
fi

discovery_root=$(mktemp -d "${TMPDIR:-/tmp}/hmux-legacy-kill-smoke.XXXXXX")
host_pid=
provider_pid=
child_pid=

# Exercise the allowlisted path used by the pre-hmux-runtime CLI, whose
# standalone Host lived at .../hmux-cli/bin/hebbian.
legacy_runtime="$discovery_root/hmux-cli/bin/hebbian"
mkdir -p -- "$(dirname "$legacy_runtime")"
cp -- "$runtime" "$legacy_runtime"
chmod 700 "$legacy_runtime"
runtime="$legacy_runtime"

cleanup() {
  "$cli" --discovery-root "$discovery_root" kill legacy-kill-smoke >/dev/null 2>&1 || true
  for process in "$host_pid" "$provider_pid" "$child_pid"; do
    if [ -n "$process" ] && kill -0 "$process" 2>/dev/null; then
      echo "legacy kill smoke: fixture process $process remained alive" >&2
      return
    fi
  done
  case "$discovery_root" in
    "${TMPDIR:-/tmp}"/hmux-legacy-kill-smoke.*) rm -r -- "$discovery_root" ;;
    *) echo "legacy kill smoke: refusing unexpected cleanup target" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

python_script='import os,time; child=os.fork(); os.setpgid(0,0) if child == 0 else None; time.sleep(300)'
env -u HMUX \
  "$cli" \
  --discovery-root "$discovery_root" \
  new \
  --name legacy-kill-smoke \
  --runtime "$runtime" \
  -- \
  "$python" \
  -c \
  "$python_script" \
  >/dev/null

manifest=$(find "$discovery_root" -name manifest.json -type f -print -quit)
if [ -z "$manifest" ]; then
  echo "legacy kill smoke: ready manifest was not published" >&2
  exit 1
fi

set -- $(node -e '
  const manifest = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(`${manifest.manifest.common.host_process.process_id} ${manifest.manifest.provider_process.process_id}`);
' "$manifest")
host_pid=$1
provider_pid=$2

deadline=$(( $(date +%s) + 5 ))
while [ -z "$child_pid" ] && [ "$(date +%s)" -le "$deadline" ]; do
  child_pid=$(pgrep -P "$provider_pid" | head -1 || true)
  [ -n "$child_pid" ] || sleep 1
done
if [ -z "$child_pid" ]; then
  echo "legacy kill smoke: provider did not create its child process" >&2
  exit 1
fi

provider_group=$(ps -o pgid= -p "$provider_pid" | tr -d ' ')
child_group=$(ps -o pgid= -p "$child_pid" | tr -d ' ')
if [ -z "$provider_group" ] || [ -z "$child_group" ] || [ "$provider_group" = "$child_group" ]; then
  echo "legacy kill smoke: fixture did not create two process groups" >&2
  exit 1
fi

node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.manifest.common.capabilities =
    manifest.manifest.common.capabilities.filter(
      (capability) => capability !== "standalone_termination_v1",
    );
  const temporary = `${path}.legacy-kill-smoke`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, path);
' "$manifest"

"$cli" --discovery-root "$discovery_root" kill legacy-kill-smoke

for process in "$host_pid" "$provider_pid" "$child_pid"; do
  if kill -0 "$process" 2>/dev/null; then
    echo "legacy kill smoke: process $process survived verified termination" >&2
    exit 1
  fi
done
if [ "$("$cli" --discovery-root "$discovery_root" --json ls)" != "[]" ]; then
  echo "legacy kill smoke: exact discovery generation was not retired" >&2
  exit 1
fi

echo "legacy kill smoke: Host, provider, and separate process group terminated"
