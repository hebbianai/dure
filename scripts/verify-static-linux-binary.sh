#!/bin/sh
set -eu

static_target=${1:-}
static_binary=${2:-}
if [ -z "$static_target" ] || [ -z "$static_binary" ]; then
  echo "usage: $0 <target-triple> <binary>" >&2
  exit 2
fi
command -v file >/dev/null 2>&1 || {
  echo "file(1) is required to verify a Linux artifact" >&2
  exit 1
}

elf_header_field() {
  od -A n -t x1 -j "$2" -N "$3" "$1" | tr -d ' \n'
}

[ "$(elf_header_field "$static_binary" 0 4)" = "7f454c46" ] || {
  echo "not an ELF binary: $static_binary" >&2
  exit 1
}
case "$static_target" in
  x86_64-*) static_expected_machine=3e00 ;;
  aarch64-*) static_expected_machine=b700 ;;
  *)
    echo "no ELF machine expectation for $static_target" >&2
    exit 1
    ;;
esac
static_actual_machine=$(elf_header_field "$static_binary" 18 2)
[ "$static_actual_machine" = "$static_expected_machine" ] || {
  echo "$static_binary is ELF machine $static_actual_machine, expected $static_expected_machine" >&2
  exit 1
}
case "$(file -b "$static_binary")" in
  *static-pie\ linked* | *statically\ linked*) ;;
  *)
    echo "$static_binary is not statically linked" >&2
    exit 1
    ;;
esac
