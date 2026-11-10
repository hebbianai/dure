#!/bin/sh
# Start a packaged Linux build on an existing (usually virtual) X display and
# require its main window to appear and stay up. The app runs in a disposable
# HOME with its own DURE_HOME, XDG directories and HMUX_DISCOVERY_ROOT, so it
# never sees or changes the caller's app, data or runtimes. Afterwards only the
# processes started here (the app's process group and any runtime carrying this
# run's discovery root) are stopped, and the disposable directories are removed.
#
# usage: linux-package-smoke.sh <AppImage or installed dure executable>
#   DISPLAY                     required, for example from `xvfb-run -a`
#   DURE_LINUX_SMOKE_EVIDENCE   directory for the log, screenshot and summary
#   DURE_LINUX_SMOKE_SECONDS    seconds to wait for the window (default 120)
set -eu

app=${1:-}
if [ -z "$app" ] || [ ! -x "$app" ]; then
  echo "usage: $0 <AppImage or installed dure executable>" >&2
  exit 2
fi
if [ -z "${DISPLAY:-}" ]; then
  echo "linux package smoke needs an X display (run it under xvfb-run)" >&2
  exit 2
fi
for tool in xdotool setsid; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "linux package smoke needs $tool" >&2
    exit 2
  }
done

seconds=${DURE_LINUX_SMOKE_SECONDS:-120}
evidence=${DURE_LINUX_SMOKE_EVIDENCE:-}
root=$(mktemp -d "${TMPDIR:-/tmp}/dure-linux-smoke.XXXXXX")
app_pid=
discovery="$root/discovery"

owned_runtimes() {
  for environ in /proc/[0-9]*/environ; do
    if tr '\0' '\n' <"$environ" 2>/dev/null | grep -Fqx "HMUX_DISCOVERY_ROOT=$discovery"; then
      pid=${environ#/proc/}
      echo "${pid%/environ}"
    fi
  done
}

cleanup() {
  if [ -n "$app_pid" ]; then
    kill -TERM -- "-$app_pid" 2>/dev/null || true
    sleep 2
    kill -KILL -- "-$app_pid" 2>/dev/null || true
  fi
  for pid in $(owned_runtimes); do
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $(owned_runtimes); do
    kill -KILL "$pid" 2>/dev/null || true
  done
  if [ -n "$evidence" ] && [ -f "$root/app.log" ]; then
    cp "$root/app.log" "$evidence/app.log"
  fi
  rm -rf -- "$root"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [ -n "$evidence" ]; then
  mkdir -p "$evidence"
fi
mkdir -p "$root/home" "$root/dure" "$discovery" "$root/run"
chmod 700 "$root/run"

# AppImages normally mount through FUSE; extracting avoids needing it here.
# WebKitGTK's DMA-BUF renderer needs a GPU device that virtual displays lack.
HOME="$root/home" \
  DURE_HOME="$root/dure" \
  HMUX_DISCOVERY_ROOT="$discovery" \
  XDG_CONFIG_HOME="$root/home/.config" \
  XDG_DATA_HOME="$root/home/.local/share" \
  XDG_CACHE_HOME="$root/home/.cache" \
  XDG_STATE_HOME="$root/home/.local/state" \
  XDG_RUNTIME_DIR="$root/run" \
  APPIMAGE_EXTRACT_AND_RUN=1 \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  setsid "$app" >"$root/app.log" 2>&1 &
app_pid=$!

window=
elapsed=0
while [ "$elapsed" -lt "$seconds" ]; do
  if ! kill -0 "$app_pid" 2>/dev/null; then
    echo "the app exited before its window appeared" >&2
    tail -n 50 "$root/app.log" >&2 || true
    exit 1
  fi
  window=$(xdotool search --onlyvisible --name '^Dure$' 2>/dev/null | head -n 1 || true)
  [ -n "$window" ] && break
  sleep 2
  elapsed=$((elapsed + 2))
done
if [ -z "$window" ]; then
  echo "no visible Dure window within ${seconds}s" >&2
  tail -n 50 "$root/app.log" >&2 || true
  exit 1
fi

# Let the interface load, then require the app to still be running.
sleep 20
if ! kill -0 "$app_pid" 2>/dev/null; then
  echo "the app exited after its window appeared" >&2
  tail -n 50 "$root/app.log" >&2 || true
  exit 1
fi
runtimes=$(owned_runtimes | wc -l | tr -d ' ')
geometry=$(xdotool getwindowgeometry "$window" | tr '\n' ' ')
if [ -n "$evidence" ]; then
  if command -v import >/dev/null 2>&1; then
    import -window root "$evidence/screen.png" || true
  fi
  {
    echo "app=$(basename "$app")"
    echo "machine=$(uname -m)"
    echo "window=$window $geometry"
    echo "owned_hmux_processes=$runtimes"
  } >"$evidence/summary.txt"
fi
echo "Dure window $window is up ($geometry); owned Hmux processes: $runtimes"
