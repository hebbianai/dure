#!/bin/sh
set -eu

# This shim runs only inside the disposable SSH fixture. Pause the real Git
# removal boundary after admission, then finish the exact confirmed deletion.
previous=
for argument in "$@"; do
  if [ "$previous" = worktree ] && [ "$argument" = remove ]; then
    case "${DURE_QA_CHECKOUT_SCOPE:-}" in
      /tmp/dure-checkout-ssh.fixture/*-unknown-linux-musl) ;;
      *) exit 71 ;;
    esac
    printf 'ready\n' >"$DURE_QA_CHECKOUT_SCOPE/permit-ready"
    IFS= read -r release <"$DURE_QA_CHECKOUT_SCOPE/permit-release"
    [ "$release" = release ] || exit 72
    break
  fi
  previous=$argument
done
exec /usr/bin/git "$@"
