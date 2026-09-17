#!/bin/sh
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  echo "linux desktop doctor must run on Linux" >&2
  exit 1
fi

if [ "$(uname -m)" != "x86_64" ]; then
  echo "linux desktop bootstrap currently supports x86_64 only" >&2
  exit 1
fi

missing=""
require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    missing="$missing command:$1"
  fi
}

for command_name in pkg-config cc c++ make curl wget file patchelf; do
  require_command "$command_name"
done

if command -v pkg-config >/dev/null 2>&1; then
  for module in dbus-1 gtk+-3.0 webkit2gtk-4.1 ayatana-appindicator3-0.1 librsvg-2.0 openssl; do
    if ! pkg-config --exists "$module"; then
      missing="$missing pkg-config:$module"
    fi
  done
fi

if [ -n "$missing" ]; then
  echo "Linux desktop prerequisites are incomplete:$missing" >&2
  echo "Ubuntu 22.04+ setup:" >&2
  echo "  sudo apt update" >&2
  echo "  sudo apt install build-essential curl wget file pkg-config patchelf libdbus-1-dev libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev" >&2
  exit 1
fi

echo "linux desktop prerequisites ready: target=x86_64-unknown-linux-gnu"
