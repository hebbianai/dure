#!/bin/sh
set -eu

checkout_helper_script_directory=$(
  CDPATH= cd -- "$(dirname -- "$0")" && pwd -P
)
checkout_helper_output_root=src-tauri/resources/remote-git-checkout-helper
checkout_helper_target_root=${CARGO_TARGET_DIR:-crates/dure-app/target}/remote-git-checkout-helper
checkout_helper_stage=

cleanup_checkout_helper_stage() {
  if [ -n "$checkout_helper_stage" ] && [ -d "$checkout_helper_stage" ] && [ ! -L "$checkout_helper_stage" ]; then
    rm -rf -- "$checkout_helper_stage"
  fi
}
trap cleanup_checkout_helper_stage EXIT
trap 'exit 1' HUP INT TERM

mkdir -p "$checkout_helper_output_root"
for checkout_helper_triple in x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
  # Target C dependencies use cc-rs, but the final static link is Rust's rust-lld,
  # not Zig's driver. Keep this release C archive free of Zig's default UBSan
  # runtime dependency and optimize it even when cross cc defaults are disabled.
  RUSTUP_TOOLCHAIN=1.97.1 \
    CARGO_TARGET_DIR="$checkout_helper_target_root" \
    TARGET_CFLAGS="${TARGET_CFLAGS:-} -O2 -fno-sanitize=undefined" \
    sh "$checkout_helper_script_directory/with-hmux-build-environment.sh" \
      "$checkout_helper_triple" -- \
      cargo build --locked --manifest-path crates/dure-app/Cargo.toml \
      --release --target "$checkout_helper_triple" \
      --package dure-session-runtime --bin dure-git-checkout-helper
  checkout_helper_binary="$checkout_helper_target_root/$checkout_helper_triple/release/dure-git-checkout-helper"
  sh "$checkout_helper_script_directory/verify-static-linux-binary.sh" \
    "$checkout_helper_triple" "$checkout_helper_binary"

  checkout_helper_output="$checkout_helper_output_root/$checkout_helper_triple"
  if [ -f "$checkout_helper_output/dure-git-checkout-helper" ] &&
    cmp -s "$checkout_helper_binary" "$checkout_helper_output/dure-git-checkout-helper"; then
    echo "Reusing remote Git checkout helper for $checkout_helper_triple"
    continue
  fi

  checkout_helper_stage=$(mktemp -d "$checkout_helper_output_root/.stage-$checkout_helper_triple.XXXXXX")
  cp "$checkout_helper_binary" "$checkout_helper_stage/dure-git-checkout-helper"
  chmod 755 "$checkout_helper_stage/dure-git-checkout-helper"
  if [ -d "$checkout_helper_output" ] && [ ! -L "$checkout_helper_output" ]; then
    rm -rf -- "$checkout_helper_output"
  elif [ -e "$checkout_helper_output" ] || [ -L "$checkout_helper_output" ]; then
    echo "refusing non-directory remote Git checkout helper resource: $checkout_helper_output" >&2
    exit 1
  fi
  mv "$checkout_helper_stage" "$checkout_helper_output"
  checkout_helper_stage=
done

trap - EXIT HUP INT TERM
