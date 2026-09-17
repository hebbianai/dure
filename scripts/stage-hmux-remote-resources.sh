#!/bin/sh
set -eu

hmux_remote_profile=${1:-debug}
case "$hmux_remote_profile" in
  debug | release) ;;
  *)
    echo "usage: $0 [debug|release]" >&2
    exit 2
    ;;
esac

hmux_remote_script_directory=$(
  CDPATH= cd -- "$(dirname -- "$0")" && pwd -P
)
if [ -n "${HMUX_BUILD_ID:-}" ]; then
  hmux_remote_build_base=$HMUX_BUILD_ID
elif [ "$hmux_remote_profile" = debug ]; then
  hmux_remote_build_base=$(node scripts/hmux-dev-build-id.mjs)
else
  if [ -n "$(git status --porcelain -- hmux crates/hebbian-process-sampler)" ]; then
    echo "refusing a dirty release Hmux bundle without HMUX_BUILD_ID" >&2
    exit 1
  fi
  hmux_remote_version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' hmux/Cargo.toml | head -n 1)
  hmux_remote_revision=$(git rev-parse --short=12 HEAD)
  hmux_remote_build_base="$hmux_remote_version+$hmux_remote_revision.dure"
fi
hmux_remote_output_root=src-tauri/resources/hmux-remote
hmux_remote_base_target_root=${CARGO_TARGET_DIR:-hmux/target}
hmux_remote_target_root=$hmux_remote_base_target_root/remote-agent-tools/$hmux_remote_build_base
hmux_remote_source_commit=$(git rev-parse HEAD)

for hmux_remote_triple in x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
  hmux_remote_build_id="$hmux_remote_build_base.$hmux_remote_triple.release"
  hmux_remote_output="$hmux_remote_output_root/$hmux_remote_triple"
  if [ -f "$hmux_remote_output/install.json" ] &&
    grep -Fqx "  \"buildId\": \"$hmux_remote_build_id\"," "$hmux_remote_output/install.json" &&
    [ ! -e "$hmux_remote_output/bin/dure-git-checkout-helper" ] &&
    [ ! -L "$hmux_remote_output/bin/dure-git-checkout-helper" ]; then
    echo "Reusing bundled Hmux $hmux_remote_build_id"
    continue
  fi

  # Keep final binaries versioned while Cargo reuses and locks its intermediates.
  RUSTUP_TOOLCHAIN=1.97.1 \
    HMUX_BUILD_ID="$hmux_remote_build_id" \
    HMUX_SOURCE_COMMIT="$hmux_remote_source_commit" \
    CARGO_BUILD_BUILD_DIR="${CARGO_BUILD_BUILD_DIR:-$hmux_remote_base_target_root/remote-agent-tools-build}" \
    CARGO_TARGET_DIR="$hmux_remote_target_root" \
    /bin/sh "$hmux_remote_script_directory/build-hmux-product-runtime.sh" \
      "$hmux_remote_triple" cargo build --locked --manifest-path hmux/Cargo.toml \
      --release --target "$hmux_remote_triple" \
      --package hmux-cli --package hmux-runtime

  hmux_remote_stage="$hmux_remote_output_root/.stage-$hmux_remote_triple-$$"
  if [ -e "$hmux_remote_stage" ] || [ -L "$hmux_remote_stage" ]; then
    echo "refusing unexpected Hmux resource stage: $hmux_remote_stage" >&2
    exit 1
  fi
  HMUX_ARTIFACT_DIR="$hmux_remote_target_root/$hmux_remote_triple/release" \
    HMUX_BUILD_ID="$hmux_remote_build_id" \
    sh scripts/package-hmux-prebuilt.sh "$hmux_remote_triple" "$hmux_remote_stage"
  if [ -d "$hmux_remote_output" ] && [ ! -L "$hmux_remote_output" ]; then
    rm -rf -- "$hmux_remote_output"
  elif [ -e "$hmux_remote_output" ] || [ -L "$hmux_remote_output" ]; then
    echo "refusing non-directory Hmux resource: $hmux_remote_output" >&2
    exit 1
  fi
  mv "$hmux_remote_stage" "$hmux_remote_output"
done
