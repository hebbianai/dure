#!/bin/sh
# Provision the Developer ID Application identity for one release job on a
# disposable GitHub-hosted macOS runner, and remove it again.
#
#   prepare  import APPLE_CERTIFICATE (base64 PKCS#12) with
#            APPLE_CERTIFICATE_PASSWORD into a new keychain under RUNNER_TEMP
#            and put that keychain first in the user search list
#   remove   delete that keychain
#
# A self-hosted signing host keeps its identity in its owner's keychain; this
# script refuses to run there, so it never mutates a persistent host's
# keychains. The certificate variables belong only to the prepare step: the
# build step must not see them, or the bundler would import the certificate
# again on its own (scripts/lib/macos-signing-readiness.mjs refuses that).
set -eu

fail() {
  echo "hosted signing keychain: $*" >&2
  exit 1
}

action=${1:-}
case "$action" in
  prepare | remove) ;;
  *) fail "usage: $0 prepare|remove" ;;
esac

[ "${GITHUB_ACTIONS:-}" = "true" ] ||
  fail "this script may run only inside GitHub Actions"
[ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ] ||
  fail "refusing to change keychains outside a disposable GitHub-hosted runner"
if [ "$action" = prepare ]; then
  [ -n "${APPLE_CERTIFICATE:-}" ] ||
    fail "APPLE_CERTIFICATE is not configured in the macos-release environment"
  [ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ] ||
    fail "APPLE_CERTIFICATE_PASSWORD is not configured in the macos-release environment"
fi
[ "$(/usr/bin/uname -s)" = Darwin ] || fail "signing keychains require macOS"

runner_temp=${RUNNER_TEMP:-}
case "$runner_temp" in
  /) fail "RUNNER_TEMP cannot be the filesystem root" ;;
  /*) runner_temp=${runner_temp%/} ;;
  *) fail "RUNNER_TEMP must be absolute" ;;
esac
[ -d "$runner_temp" ] || fail "RUNNER_TEMP does not exist"
keychain=$runner_temp/dure-signing.keychain-db

if [ "$action" = remove ]; then
  if [ -e "$keychain" ] || [ -L "$keychain" ]; then
    /usr/bin/security delete-keychain "$keychain"
    echo "Removed the hosted signing keychain"
  else
    echo "No hosted signing keychain to remove"
  fi
  exit 0
fi

[ ! -e "$keychain" ] && [ ! -L "$keychain" ] ||
  fail "a hosted signing keychain already exists in this job"

umask 077
scratch=$(/usr/bin/mktemp -d "$runner_temp/dure-signing-import.XXXXXX")
cleanup() {
  /bin/rm -rf -- "$scratch"
}
trap cleanup 0
trap 'exit 1' 1 2 3 15

# A wrapped (multi-line) base64 export decodes the same as a single line.
printf '%s' "$APPLE_CERTIFICATE" | /usr/bin/tr -d ' \r\n' |
  /usr/bin/base64 --decode >"$scratch/certificate.p12" ||
  fail "APPLE_CERTIFICATE is not base64"
[ -s "$scratch/certificate.p12" ] || fail "APPLE_CERTIFICATE decodes to nothing"

# The keychain password only guards this job's keychain; it is generated here
# and never leaves the job.
keychain_password=$(/usr/bin/od -An -N32 -tx1 /dev/urandom | /usr/bin/tr -d ' \n')
[ "${#keychain_password}" -eq 64 ] || fail "could not generate a keychain password"
echo "::add-mask::$keychain_password"

/usr/bin/security create-keychain -p "$keychain_password" "$keychain"
# Lock after six hours or on sleep, never sooner than the build can finish.
/usr/bin/security set-keychain-settings -lut 21600 "$keychain"
/usr/bin/security unlock-keychain -p "$keychain_password" "$keychain"
/usr/bin/security import "$scratch/certificate.p12" -k "$keychain" \
  -f pkcs12 -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null ||
  fail "the certificate could not be imported; check APPLE_CERTIFICATE_PASSWORD"
# Without this, codesign waits for a keychain access dialog nobody can answer.
/usr/bin/security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$keychain_password" "$keychain" >/dev/null

# codesign and `security find-identity` search the user list: put this job's
# keychain first and keep the runner's own keychains after it.
existing_keychains=$(/usr/bin/security list-keychains -d user | /usr/bin/sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')
old_ifs=$IFS
IFS='
'
set -f
# shellcheck disable=SC2086 # one keychain path per line, never globbed
/usr/bin/security list-keychains -d user -s "$keychain" $existing_keychains
set +f
IFS=$old_ifs

echo "Imported the signing identity into a keychain owned by this job"
