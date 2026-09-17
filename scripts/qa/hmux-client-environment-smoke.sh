#!/bin/sh
set -eu

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." && pwd
)
cd "$repo_root"
: "${DURE_HMUX_TEST_STATE_ROOT:?run through pnpm test:hmux-client-environment}"

target_triple=$(rustc -vV | sed -n 's/^host: //p')
if [ -z "$target_triple" ] || [ "${CARGO_BUILD_TARGET:-$target_triple}" != "$target_triple" ]; then
  echo "client environment smoke requires the current native Rust target" >&2
  exit 1
fi
case "$(uname -s)" in
  Darwin | Linux) ;;
  *) echo "client environment smoke requires a native Unix target" >&2; exit 1 ;;
esac

cargo test --locked --manifest-path hmux/Cargo.toml \
  -p hmux-runtime -p hmux-runtime-contract \
  --test launching_client_environment --no-fail-fast -- --nocapture
