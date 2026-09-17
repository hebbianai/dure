#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /tmp/dure-spawn-prompt-ssh.<token>" >&2
  exit 64
fi

root=$1
case "$root" in
  /tmp/dure-spawn-prompt-ssh.*)
    token=${root#/tmp/dure-spawn-prompt-ssh.}
    ;;
  *)
    echo "receipt-loss guest root is unsafe" >&2
    exit 64
    ;;
esac
case "$token" in
  "" | [!A-Za-z0-9]* | *[!A-Za-z0-9._-]*)
    echo "receipt-loss guest root is unsafe" >&2
    exit 64
    ;;
esac
incoming="$root/incoming"
public_key=$(awk 'NR == 1 { print $1, $2 }' "$incoming/client.pub")
set -- $public_key
if [ "$#" -ne 2 ] || [ "$1" != ssh-ed25519 ]; then
  echo "invalid receipt-loss client key" >&2
  exit 1
fi
key_blob=$2
case "$key_blob" in
  "" | *[!A-Za-z0-9+/=]*)
    echo "invalid receipt-loss client key" >&2
    exit 1
    ;;
esac
key_line="restrict ssh-ed25519 $key_blob dure-ssh-receipt-loss"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
authorized_keys="$HOME/.ssh/authorized_keys"
touch "$authorized_keys"
chmod 600 "$authorized_keys"
matching=$(grep -F "$key_blob" "$authorized_keys" || true)
if [ -z "$matching" ]; then
  printf '%s\n' "$key_line" >>"$authorized_keys"
elif [ "$matching" != "$key_line" ] ||
  [ "$(grep -Fxc "$key_line" "$authorized_keys")" -ne 1 ]; then
  echo "receipt-loss client key has ambiguous authorization" >&2
  exit 1
fi

mkdir -m 700 "$root/bin" "$root/provider-capture" "$root/project"
cp "$incoming/claude" "$root/bin/claude"
cp "$incoming/dure-qa-fake-provider-common.sh" \
  "$root/bin/dure-qa-fake-provider-common.sh"
chmod 700 "$root/bin/claude"
chmod 600 "$root/bin/dure-qa-fake-provider-common.sh"

git -C "$root/project" init -q -b main
printf '%s\n' 'SSH receipt-loss fixture' >"$root/project/README.md"
git -C "$root/project" add README.md
git -C "$root/project" \
  -c user.email=qa@qa \
  -c user.name=qa \
  -c commit.gpgsign=false \
  commit -q -m base

profile="$root/provider-profile.sh"
{
  printf "PATH='%s/bin':\"\$PATH\"\n" "$root"
  printf "DURE_QA_CAPTURE_DIR='%s/provider-capture'\n" "$root"
  printf 'HEBBIAN_QA_CAPTURE_DIR="$DURE_QA_CAPTURE_DIR"\n'
  printf 'export PATH DURE_QA_CAPTURE_DIR HEBBIAN_QA_CAPTURE_DIR\n'
} >"$profile"
chmod 600 "$profile"
printf '\n. %s\n' "$profile" >>"$HOME/.profile"
