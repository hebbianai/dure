#!/bin/sh
set -eu

hmux_product_runtime_mode=${1:-}
hmux_product_runtime=${2:-}
hmux_product_profile=structured-terminal-v1
hmux_product_marker="hmux-product-profile=$hmux_product_profile"

if [ -z "$hmux_product_runtime" ]; then
  echo "usage: $0 <execute|marker> <hmux-runtime>" >&2
  exit 2
fi
if [ ! -f "$hmux_product_runtime" ] || [ ! -x "$hmux_product_runtime" ]; then
  echo "Hmux product runtime is missing or not executable: $hmux_product_runtime" >&2
  exit 1
fi

case "$hmux_product_runtime_mode" in
  execute)
    hmux_product_build_info=$(
      "$hmux_product_runtime" --no-autostart hmux-build-info
    ) || {
      echo "Hmux product runtime did not report build information: $hmux_product_runtime" >&2
      exit 1
    }
    printf '%s\n' "$hmux_product_build_info" |
      grep -Fq "\"productProfile\":\"$hmux_product_profile\"" || {
      echo "Hmux runtime is not the structured product profile: $hmux_product_runtime" >&2
      exit 1
    }
    ;;
  marker)
    LC_ALL=C grep -aFq "$hmux_product_marker" "$hmux_product_runtime" || {
      echo "Hmux runtime has no structured product-profile marker: $hmux_product_runtime" >&2
      exit 1
    }
    ;;
  *)
    echo "usage: $0 <execute|marker> <hmux-runtime>" >&2
    exit 2
    ;;
esac
