#!/bin/sh
set -eu

scripts_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$scripts_root/lib/native-build-slot.mjs" -- cargo "$@"
