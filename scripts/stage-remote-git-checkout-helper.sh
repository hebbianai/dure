#!/bin/sh
set -eu

checkout_helper_script_directory=$(
  CDPATH= cd -- "$(dirname -- "$0")" && pwd -P
)
if [ -n "${DURE_CHECKOUT_HELPER_ARTIFACT_ROOT:-}" ]; then
  exec node "$checkout_helper_script_directory/remote-git-checkout-helper-artifact.mjs" \
    stage "$DURE_CHECKOUT_HELPER_ARTIFACT_ROOT"
fi
exec node "$checkout_helper_script_directory/remote-git-checkout-helper-artifact.mjs" prepare
