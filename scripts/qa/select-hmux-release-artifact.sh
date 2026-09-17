#!/bin/sh
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <artifacts-json> <source-commit> <workflow-run-id> <workflow-run-attempt>" >&2
  exit 2
fi

artifacts_json=$1
source_commit=$2
workflow_run_id=$3
workflow_run_attempt=$4

if [ ! -f "$artifacts_json" ]; then
  echo "hmux release artifact selection: artifacts JSON is missing" >&2
  exit 2
fi
if ! printf '%s\n' "$source_commit" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "hmux release artifact selection: source commit must be full lowercase hex" >&2
  exit 2
fi
case "$workflow_run_id" in
  *[!0-9]* | "" | 0 | 0*)
    echo "hmux release artifact selection: workflow identity must be positive integers" >&2
    exit 2
    ;;
esac
case "$workflow_run_attempt" in
  *[!0-9]* | "" | 0 | 0*)
    echo "hmux release artifact selection: workflow identity must be positive integers" >&2
    exit 2
    ;;
esac

candidate_name="hmux-linux-musl-$workflow_run_id-$workflow_run_attempt-$source_commit"
evidence_name="hmux-linux-native-evidence-$workflow_run_id-$workflow_run_attempt-$source_commit"

# A successful artifact workflow currently publishes the packaged candidate
# and its native-execution evidence. Historical successful runs may predate the
# evidence artifact, so one exact candidate is accepted with zero or one exact
# evidence companion. Any other artifact makes the release hand-off ambiguous.
jq -e \
  --arg candidate_name "$candidate_name" \
  --arg evidence_name "$evidence_name" \
  --arg source "$source_commit" \
  --argjson run_id "$workflow_run_id" \
  '
    def positive_safe_integer:
      type == "number" and
      . > 0 and
      . == floor and
      . <= 9007199254740991;
    def digest_is_sha256:
      (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"));
    def bound_to_run:
      (.id | positive_safe_integer) and
      (.expired == false) and
      (.workflow_run | type == "object") and
      (.workflow_run.id == $run_id) and
      (.workflow_run.head_sha == $source) and
      digest_is_sha256;
    def candidate_is_valid:
      bound_to_run and
      (.size_in_bytes | positive_safe_integer and . <= 268435456);
    def evidence_is_valid:
      bound_to_run and
      (.size_in_bytes | positive_safe_integer and . <= 16777216);

    select(type == "object") |
    select(.total_count | type == "number") |
    select(.artifacts | type == "array") |
    select(.total_count == (.artifacts | length)) |
    select((.artifacts | length) >= 1 and (.artifacts | length) <= 2) |
    select(
      (.artifacts | map(.name) | length) ==
      (.artifacts | map(.name) | unique | length)
    ) |
    select(
      all(
        .artifacts[];
        if .name == $candidate_name then
          candidate_is_valid
        elif .name == $evidence_name then
          evidence_is_valid
        else
          false
        end
      )
    ) |
    [.artifacts[] | select(.name == $candidate_name)] |
    select(length == 1) |
    .[0]
  ' "$artifacts_json"
