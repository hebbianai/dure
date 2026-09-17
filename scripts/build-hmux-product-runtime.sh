#!/bin/sh
set -eu

hmux_product_target=${1:-}
if [ "$#" -eq 0 ]; then
  echo "usage: $0 <target-triple> <cargo-command> [args...]" >&2
  exit 2
fi
shift
if [ "${1:-}" = "--" ]; then
  shift
fi
if [ "$#" -eq 0 ]; then
  echo "product Hmux build requires a Cargo command" >&2
  exit 2
fi
hmux_product_script_directory=$(
  CDPATH= cd -- "$(dirname -- "$0")" && pwd -P
)

hmux_product_feature=hmux-runtime/terminal-state-stream
hmux_product_has_feature=0
hmux_product_feature_value_follows=0
hmux_product_has_cargo_separator=0
for hmux_product_argument in "$@"; do
  if [ "$hmux_product_feature_value_follows" = 1 ]; then
    case ",$hmux_product_argument," in
      *",$hmux_product_feature,"*) hmux_product_has_feature=1 ;;
    esac
    hmux_product_feature_value_follows=0
    continue
  fi
  case "$hmux_product_argument" in
    --features) hmux_product_feature_value_follows=1 ;;
    --features=*)
      case ",${hmux_product_argument#--features=}," in
        *",$hmux_product_feature,"*) hmux_product_has_feature=1 ;;
      esac
      ;;
    --) hmux_product_has_cargo_separator=1 ;;
  esac
done

if [ "$hmux_product_has_feature" = 1 ]; then
  sh "$hmux_product_script_directory/with-hmux-build-environment.sh" "$hmux_product_target" -- "$@"
elif [ "$hmux_product_has_cargo_separator" = 1 ]; then
  echo "product Hmux Cargo command must put --features $hmux_product_feature before --" >&2
  exit 2
else
  sh "$hmux_product_script_directory/with-hmux-build-environment.sh" "$hmux_product_target" -- \
    "$@" --features "$hmux_product_feature"
fi
