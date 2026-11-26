#!/bin/sh
# Starts the push service as `node`, with no supplementary groups.
#
# It runs as root only to hand two paths to `node`: the state directory (a
# Fly volume, mounted root-owned) and the APNs key file (written by Fly from a
# secret). main.mjs refuses to run as root, so a failed drop stops the service
# instead of running it privileged.
set -eu
state="${DURE_PUSH_STATE_DIR:?DURE_PUSH_STATE_DIR is required}"
key="${DURE_APNS_KEY_FILE:?DURE_APNS_KEY_FILE is required}"
mkdir -p "$state"
chown -R node:node "$state"
chmod 0700 "$state"
chown node:node "$key"
chmod 0400 "$key"
exec setpriv --reuid=node --regid=node --clear-groups -- node mobile/push-service/main.mjs
