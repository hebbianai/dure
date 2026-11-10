#!/bin/sh
# Start a packaged Linux build on an existing (usually virtual) X display and
# require its main window to appear and stay up, the Dure CLI it carries to be
# installed into the home and its backend to start. The app runs in a disposable
# HOME with its own DURE_HOME, XDG directories and HMUX_DISCOVERY_ROOT, so it
# never sees or changes the caller's app, data or runtimes. Afterwards only the
# processes started here (the app's process group and anything carrying this
# run's home or discovery root) are stopped, and the disposable directories are
# removed.
#
# With DURE_LINUX_SMOKE_TERMINAL=1 it also opens a terminal pane from the
# first-run screen and runs a command and `dure ls` there, writing a proof file.
# That step clicks fixed positions of the 1480x940 window on a display without a
# window manager, so a layout change can break it without a product defect.
#
# usage: linux-package-smoke.sh <AppImage or installed dure executable>
#   DISPLAY                     required, for example from `xvfb-run -a`
#   DURE_LINUX_SMOKE_EVIDENCE   directory for the log, screenshots and summary
#   DURE_LINUX_SMOKE_SECONDS    seconds to wait for each step (default 120)
#   DURE_LINUX_SMOKE_TERMINAL   1 to require a terminal command (default 0)
#   DURE_LINUX_SMOKE_AGENT      1 to also start a managed agent from that
#                               terminal; `claude` on PATH must be the QA fake
#                               provider (scripts/qa/fake-provider/claude)
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
agent=${DURE_LINUX_SMOKE_AGENT:-0}
if [ "$agent" = 1 ]; then
  [ "$terminal" = 1 ] || {
    echo "the agent step runs in the terminal pane; set DURE_LINUX_SMOKE_TERMINAL=1" >&2
    exit 2
  }
  # Never start a real provider with whatever account the caller has.
  case "$(claude --version 2>/dev/null || true)" in
    *-dure-qa) ;;
    *)
      echo "the agent step needs the QA fake provider as claude on PATH" >&2
      exit 2
      ;;
  esac
fi
root=$(mktemp -d "${TMPDIR:-/tmp}/dure-linux-smoke.XXXXXX")
app_pid=
discovery="$root/discovery"
proof="$root/terminal-proof"

# Processes of this user that carry this run's home or discovery root. The
# backend detaches from the app and may run with a reduced environment, so its
# command line (which names the discovery root) counts too.
owned_processes() {
  for environ in /proc/[0-9]*/environ; do
    [ -r "$environ" ] || continue
    pid=${environ#/proc/}
    pid=${pid%/environ}
    if { tr '\0' '\n' <"$environ"; } 2>/dev/null |
      grep -Fqx -e "HMUX_DISCOVERY_ROOT=$discovery" -e "HOME=$root/home"; then
      echo "$pid"
    elif { tr '\0' '\n' <"/proc/$pid/cmdline"; } 2>/dev/null | grep -Fqx "$discovery"; then
      echo "$pid"
    fi
  done
}

owned_backend_processes() {
  for pid in $(owned_processes); do
    if { tr '\0' ' ' <"/proc/$pid/cmdline"; } 2>/dev/null | grep -q 'dure-control-plane serve'; then
      echo "$pid"
    fi
  done
}

# Hmux processes by executable name; the backend only names Hmux in its arguments.
owned_hmux_processes() {
  for pid in $(owned_processes); do
    executable=$({ tr '\0' '\n' <"/proc/$pid/cmdline"; } 2>/dev/null | head -n 1)
    case "${executable##*/}" in
      hmux | hmux-runtime) echo "$pid" ;;
    esac
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

# A stable build installs the Dure CLI it carries into the home, then starts
# the backend from it.
cli_install="$root/home/.local/share/hebbian-ide-cli"
elapsed=0
until [ -f "$cli_install/current/install.json" ]; do
  kill -0 "$app_pid" 2>/dev/null || fail "the app exited before it installed its Dure CLI"
  [ "$elapsed" -lt "$seconds" ] || fail "the app did not install its packaged Dure CLI within ${seconds}s"
  sleep 2
  elapsed=$((elapsed + 2))
done
cli_build=$(basename "$(readlink -f "$cli_install/current")")
elapsed=0
until [ -n "$(owned_backend_processes)" ]; do
  kill -0 "$app_pid" 2>/dev/null || fail "the app exited before its backend started"
  [ "$elapsed" -lt "$seconds" ] || fail "no Dure backend started within ${seconds}s"
  sleep 2
  elapsed=$((elapsed + 2))
done

# Provider hooks must run the backend companion from that installation: an
# AppImage's own files are a mount that disappears when the app exits.
elapsed=0
hook=
until [ -n "$hook" ]; do
  hook=$(find "$root" -name 'managed-claude-hook-v2.sh' 2>/dev/null | head -n 1)
  [ -n "$hook" ] && break
  [ "$elapsed" -lt "$seconds" ] || fail "the app published no managed Claude hook within ${seconds}s"
  sleep 2
  elapsed=$((elapsed + 2))
done
grep -q "^exec '$cli_install/versions/[^/]*/bin/dure-control-plane' managed-claude-hook\$" "$hook" ||
  fail "the managed Claude hook does not run the installed Dure CLI: $(cat "$hook")"

# Let the interface load, then require the app to still be running.
sleep 20
kill -0 "$app_pid" 2>/dev/null || fail "the app exited after its window appeared"
if grep -q 'backend reconcile failed' "$root/app.log"; then
  grep 'backend reconcile failed' "$root/app.log" | tail -n 3 >&2
  fail "the app reported a backend failure"
fi
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
  # The shell, then the Dure CLI the app installed, as a user would run it.
  xdotool type --delay 50 "{ echo \$((6*7)); command -v dure; dure ls; echo dure-exit=\$?; } > $proof 2>&1"
  xdotool key Return
  elapsed=0
  until grep -q '^dure-exit=' "$proof" 2>/dev/null; do
    [ "$elapsed" -lt "$seconds" ] || fail "the terminal command did not write its proof"
    sleep 2
    elapsed=$((elapsed + 2))
  done
  screenshot terminal
  if [ -n "$evidence" ]; then
    cp "$proof" "$evidence/terminal-proof.txt"
  fi
  [ "$(head -n 1 "$proof")" = 42 ] || fail "the terminal did not run the shell command: $(cat "$proof")"
  # The app puts its own command bridge for the installed CLI on the
  # terminal's PATH; either lives in this run's disposable roots.
  case "$(sed -n 2p "$proof")" in
    "$root/"*) ;;
    *) fail "dure in the terminal is not the Dure CLI the app installed: $(cat "$proof")" ;;
  esac
  grep -qx 'dure-exit=0' "$proof" || fail "dure ls failed in the terminal: $(cat "$proof")"
  terminal_result="command and dure ls ran in an Hmux terminal pane"
fi

agent_result=skipped
if [ "$agent" = 1 ]; then
  agent_proof="$root/agent-proof"
  project="$root/home/smoke-project"
  # Claude asks whether to trust a new folder before it reads the prompt;
  # record that this disposable project was trusted, as Claude itself does.
  (umask 077 && printf '{"projects":{"%s":{"hasTrustDialogAccepted":true}}}\n' "$project" >"$root/home/.claude.json")
  # Register a project and start a Run from the terminal pane, as a user would.
  # The backend refuses a group-writable project root, and Ubuntu logins use
  # umask 002, so the project is created 0755 explicitly.
  xdotool type --delay 30 "{ mkdir -m 755 $project && git -C $project init -q && dure projects register smoke --path $project && dure run --project smoke --name smoke-agent ok; echo run-exit=\$?; dure ls; echo ls-exit=\$?; } > $agent_proof 2>&1"
  xdotool key Return
  elapsed=0
  until grep -q '^ls-exit=' "$agent_proof" 2>/dev/null; do
    [ "$elapsed" -lt "$seconds" ] || fail "dure run did not finish"
    sleep 2
    elapsed=$((elapsed + 2))
  done
  grep -qx 'run-exit=0' "$agent_proof" || fail "dure run failed: $(cat "$agent_proof")"
  provider=
  elapsed=0
  while [ -z "$provider" ]; do
    for pid in $(owned_processes); do
      if { tr '\0' ' ' <"/proc/$pid/cmdline"; } 2>/dev/null | grep -q 'bin/claude'; then
        provider=$pid
      fi
    done
    [ -n "$provider" ] && break
    [ "$elapsed" -lt "$seconds" ] || fail "no provider process started for the managed agent"
    sleep 2
    elapsed=$((elapsed + 2))
  done
  sed -n '/^run-exit=/,$p' "$agent_proof" | grep -q 'smoke-agent' ||
    fail "dure ls does not list the started agent: $(cat "$agent_proof")"
  sleep 5
  screenshot agent
  if [ -n "$evidence" ]; then
    cp "$agent_proof" "$evidence/agent-proof.txt"
  fi
  agent_result="managed agent smoke-agent started (provider pid $provider)"
fi

hmux=$(owned_hmux_processes | wc -l | tr -d ' ')
summary="window $window ($geometry); Dure CLI $cli_build installed, backend running; owned Hmux processes: $hmux; terminal: $terminal_result; agent: $agent_result"
if [ -n "$evidence" ]; then
  {
    echo "app=$(basename "$app")"
    echo "machine=$(uname -m)"
    echo "$summary"
  } >"$evidence/summary.txt"
fi
echo "Dure $summary"
