#!/bin/sh
# Start a packaged Linux build on an existing (usually virtual) X display and
# require its main window to appear and stay up. The app runs in a disposable
# HOME with its own DURE_HOME, XDG directories and HMUX_DISCOVERY_ROOT, so it
# never sees or changes the caller's app, data or runtimes. Afterwards only the
# processes started here (the app's process group and anything carrying this
# run's discovery root) are stopped, and the disposable directories are removed.
#
# With DURE_LINUX_SMOKE_TERMINAL=1 it also opens a terminal pane from the
# first-run screen and runs a command there that writes a proof file. That step
# clicks fixed positions of the 1480x940 window on a display without a window
# manager, so a layout change can break it without a product defect.
#
# usage: linux-package-smoke.sh <AppImage or installed dure executable>
#   DISPLAY                     required, for example from `xvfb-run -a`
#   DURE_LINUX_SMOKE_EVIDENCE   directory for the log, screenshots and summary
#   DURE_LINUX_SMOKE_SECONDS    seconds to wait for each step (default 120)
#   DURE_LINUX_SMOKE_TERMINAL   1 to require a terminal command (default 0)
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
terminal=${DURE_LINUX_SMOKE_TERMINAL:-0}
root=$(mktemp -d "${TMPDIR:-/tmp}/dure-linux-smoke.XXXXXX")
app_pid=
discovery="$root/discovery"
proof="$root/terminal-proof"

# Processes of this user that carry this run's discovery root.
owned_processes() {
  for environ in /proc/[0-9]*/environ; do
    [ -r "$environ" ] || continue
    if { tr '\0' '\n' <"$environ"; } 2>/dev/null | grep -Fqx "HMUX_DISCOVERY_ROOT=$discovery"; then
      pid=${environ#/proc/}
      echo "${pid%/environ}"
    fi
  done
}

owned_hmux_processes() {
  for pid in $(owned_processes); do
    if { tr '\0' ' ' <"/proc/$pid/cmdline"; } 2>/dev/null | grep -q 'hmux'; then
      echo "$pid"
    fi
  done
}

screenshot() {
  if [ -n "$evidence" ] && command -v import >/dev/null 2>&1; then
    import -window root "$evidence/$1.png" || true
  fi
}

fail() {
  echo "$1" >&2
  screenshot failure
  tail -n 50 "$root/app.log" >&2 || true
  exit 1
}

cleanup() {
  if [ -n "$app_pid" ]; then
    kill -TERM -- "-$app_pid" 2>/dev/null || true
    sleep 2
    kill -KILL -- "-$app_pid" 2>/dev/null || true
  fi
  for pid in $(owned_processes); do
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $(owned_processes); do
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
# Hmux refuses a discovery root or runtime directory others can write.
chmod 700 "$root/home" "$root/dure" "$discovery" "$root/run"

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
  kill -0 "$app_pid" 2>/dev/null || fail "the app exited before its window appeared"
  window=$(xdotool search --onlyvisible --name '^Dure$' 2>/dev/null | head -n 1 || true)
  [ -n "$window" ] && break
  sleep 2
  elapsed=$((elapsed + 2))
done
[ -n "$window" ] || fail "no visible Dure window within ${seconds}s"

# Let the interface load, then require the app to still be running.
sleep 20
kill -0 "$app_pid" 2>/dev/null || fail "the app exited after its window appeared"
geometry=$(xdotool getwindowgeometry "$window" | tr '\n' ' ')
screenshot started

click() {
  xdotool mousemove --window "$window" "$1" "$2" click 1
  sleep 2
}

terminal_result=skipped
if [ "$terminal" = 1 ]; then
  # Dismiss the first-run tooling notice and guide, then pick "Terminal" in
  # the empty space's launcher.
  click 1435 711
  click 1450 67
  click 751 461
  elapsed=0
  while [ -z "$(owned_hmux_processes)" ]; do
    [ "$elapsed" -lt "$seconds" ] || fail "no Hmux runtime started for the terminal pane"
    sleep 2
    elapsed=$((elapsed + 2))
  done
  sleep 5
  click 880 400
  xdotool type --delay 50 "echo \$((6*7)) > $proof"
  xdotool key Return
  elapsed=0
  until [ "$(cat "$proof" 2>/dev/null || true)" = 42 ]; do
    [ "$elapsed" -lt "$seconds" ] || fail "the terminal command did not write its proof"
    sleep 2
    elapsed=$((elapsed + 2))
  done
  terminal_result="command ran in an Hmux terminal pane"
  screenshot terminal
fi

hmux=$(owned_hmux_processes | wc -l | tr -d ' ')
summary="window $window ($geometry); owned Hmux processes: $hmux; terminal: $terminal_result"
if [ -n "$evidence" ]; then
  {
    echo "app=$(basename "$app")"
    echo "machine=$(uname -m)"
    echo "$summary"
  } >"$evidence/summary.txt"
fi
echo "Dure $summary"
