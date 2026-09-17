#!/bin/sh
set -eu

case "${HMUX_GHOSTTY_CROSS_TARGET:-}" in
  x86_64-unknown-linux-musl) hmux_zig_target=x86_64-linux-musl ;;
  aarch64-unknown-linux-musl) hmux_zig_target=aarch64-linux-musl ;;
  *)
    echo "Hmux Ghostty C wrapper requires an exact Linux musl target" >&2
    exit 2
    ;;
esac
hmux_zig=${HMUX_GHOSTTY_CROSS_ZIG:-}
if [ ! -f "$hmux_zig" ] || [ ! -x "$hmux_zig" ]; then
  echo "Hmux Ghostty C wrapper has no staged Zig executable" >&2
  exit 1
fi
exec "$hmux_zig" cc -target "$hmux_zig_target" -fPIC "$@"
