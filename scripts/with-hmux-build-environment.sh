#!/bin/sh
set -eu

hmux_product_target=${1:-}
if [ -z "$hmux_product_target" ]; then
  echo "usage: $0 <target-triple> <command> [args...]" >&2
  exit 2
fi
shift
if [ "${1:-}" = "--" ]; then
  shift
fi
if [ "$#" -eq 0 ]; then
  echo "Hmux build environment requires a command" >&2
  exit 2
fi
if ! printf '%s\n' "$hmux_product_target" |
  grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'; then
  echo "product Hmux target triple contains unsafe characters" >&2
  exit 2
fi

hmux_product_script_directory=$(
  CDPATH= cd -- "$(dirname -- "$0")" && pwd -P
)
hmux_product_proof=${HMUX_GHOSTTY_VT_PROOF_PREFIX:-}
if [ -z "$hmux_product_proof" ]; then
  hmux_product_proof=$(
    node "$hmux_product_script_directory/ensure-ghostty-vt-proof.mjs" \
      --target "$hmux_product_target"
  )
fi
case "$hmux_product_proof" in
  [A-Za-z]:\\*)
    hmux_product_proof=$(printf '%s\n' "$hmux_product_proof" | tr '\\' '/')
    ;;
esac
case "$hmux_product_proof" in
  /* | [A-Za-z]:/*) ;;
  *)
    echo "HMUX_GHOSTTY_VT_PROOF_PREFIX must be absolute" >&2
    exit 1
    ;;
esac
if [ ! -d "$hmux_product_proof" ] ||
  [ ! -f "$hmux_product_proof/hmux-ghostty-vt-proof.receipt" ]; then
  echo "validated Ghostty VT artifact is missing: $hmux_product_proof" >&2
  exit 1
fi
HMUX_GHOSTTY_VT_PROOF_PREFIX=$hmux_product_proof
export HMUX_GHOSTTY_VT_PROOF_PREFIX

# The Linux release builder is a macOS ARM64 host. Rust's final link remains
# the repository-pinned rust-lld boundary; only cc-rs's target C shim and its
# archive need a cross tool. Copy the receipt-pinned Zig toolchain archive into
# an invocation-owned root and rehash it before extraction, so the wrappers
# never execute a mutable provenance pathname after receipt validation.
# cc-rs's Rust target spelling is not a Zig target query; disabling its default
# flags lets the wrapper provide the reviewed `*-linux-musl` target exactly.
hmux_product_zig_stage=
hmux_product_cleanup_zig() {
  if [ -z "$hmux_product_zig_stage" ]; then
    return
  fi
  case "$hmux_product_zig_stage" in
    */hmux-product-zig.??????) ;;
    *)
      echo "refusing to clean an unexpected Hmux Zig stage: $hmux_product_zig_stage" >&2
      return
      ;;
  esac
  if [ -d "$hmux_product_zig_stage" ] && [ ! -L "$hmux_product_zig_stage" ]; then
    /bin/chmod -R u+w "$hmux_product_zig_stage" 2>/dev/null || true
    /bin/rm -rf -- "$hmux_product_zig_stage"
  fi
  hmux_product_zig_stage=
}

if [ "$(/usr/bin/uname -s)" = Darwin ]; then
  case "$hmux_product_target" in
    x86_64-unknown-linux-musl)
      HMUX_GHOSTTY_CROSS_TARGET=$hmux_product_target
      CRATE_CC_NO_DEFAULTS=1
      CFLAGS_x86_64_unknown_linux_musl=-fPIC
      CC_x86_64_unknown_linux_musl="$hmux_product_script_directory/hmux-ghostty-zig-cc.sh"
      AR_x86_64_unknown_linux_musl="$hmux_product_script_directory/hmux-ghostty-zig-ar.sh"
      export HMUX_GHOSTTY_CROSS_TARGET
      export CRATE_CC_NO_DEFAULTS
      export CFLAGS_x86_64_unknown_linux_musl
      export CC_x86_64_unknown_linux_musl
      export AR_x86_64_unknown_linux_musl
      ;;
    aarch64-unknown-linux-musl)
      HMUX_GHOSTTY_CROSS_TARGET=$hmux_product_target
      CRATE_CC_NO_DEFAULTS=1
      CFLAGS_aarch64_unknown_linux_musl=-fPIC
      CC_aarch64_unknown_linux_musl="$hmux_product_script_directory/hmux-ghostty-zig-cc.sh"
      AR_aarch64_unknown_linux_musl="$hmux_product_script_directory/hmux-ghostty-zig-ar.sh"
      export HMUX_GHOSTTY_CROSS_TARGET
      export CRATE_CC_NO_DEFAULTS
      export CFLAGS_aarch64_unknown_linux_musl
      export CC_aarch64_unknown_linux_musl
      export AR_aarch64_unknown_linux_musl
      ;;
  esac
fi

if [ -n "${HMUX_GHOSTTY_CROSS_TARGET:-}" ]; then
  hmux_product_zig_archive_source="$hmux_product_proof/provenance/zig.tar.xz"
  if [ ! -f "$hmux_product_zig_archive_source" ]; then
    echo "validated Ghostty proof has no Zig toolchain archive" >&2
    exit 1
  fi
  umask 077
  hmux_product_zig_stage=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/hmux-product-zig.XXXXXX")
  /bin/chmod 700 "$hmux_product_zig_stage"
  trap hmux_product_cleanup_zig 0
  /bin/cp "$hmux_product_zig_archive_source" "$hmux_product_zig_stage/zig.tar.xz"
  hmux_product_zig_archive_sha=$(
    /usr/bin/shasum -a 256 "$hmux_product_zig_stage/zig.tar.xz" |
      /usr/bin/awk '{print $1}'
  )
  if [ "$hmux_product_zig_archive_sha" != "b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489" ]; then
    echo "staged Zig archive does not match the reviewed Ghostty receipt" >&2
    exit 1
  fi
  /bin/mkdir "$hmux_product_zig_stage/toolchain"
  /usr/bin/tar -xJf "$hmux_product_zig_stage/zig.tar.xz" \
    -C "$hmux_product_zig_stage/toolchain" --strip-components=1
  HMUX_GHOSTTY_CROSS_ZIG="$hmux_product_zig_stage/toolchain/zig"
  hmux_product_zig_sha=$(
    /usr/bin/shasum -a 256 "$HMUX_GHOSTTY_CROSS_ZIG" | /usr/bin/awk '{print $1}'
  )
  if [ "$hmux_product_zig_sha" != "e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec" ] ||
    [ ! -x "$HMUX_GHOSTTY_CROSS_ZIG" ]; then
    echo "staged Zig executable does not match the reviewed Ghostty receipt" >&2
    exit 1
  fi
  export HMUX_GHOSTTY_CROSS_ZIG
fi

node "$hmux_product_script_directory/lib/native-build-slot.mjs" -- "$@"
