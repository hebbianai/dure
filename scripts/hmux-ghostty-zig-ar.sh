#!/bin/sh
set -eu

case "${HMUX_GHOSTTY_CROSS_TARGET:-}" in
  x86_64-unknown-linux-musl | aarch64-unknown-linux-musl) ;;
  *)
    echo "Hmux Ghostty archive wrapper requires an exact Linux musl target" >&2
    exit 2
    ;;
esac
hmux_zig=${HMUX_GHOSTTY_CROSS_ZIG:-}
if [ ! -f "$hmux_zig" ] || [ ! -x "$hmux_zig" ]; then
  echo "Hmux Ghostty archive wrapper has no staged Zig executable" >&2
  exit 1
fi
exec "$hmux_zig" ar "$@"
