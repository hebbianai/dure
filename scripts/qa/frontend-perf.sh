#!/bin/sh
# One-command frontend performance measurement against a production-minified
# bundle. Builds in `perf` mode (prod minify + measurement hooks), serves it on
# a throwaway port, runs the Playwright harness, and tears the server down.
#
#   pnpm perf:frontend            # → /tmp/frontend-perf.json + a summary table
#
# Requires Playwright's chromium: `pnpm exec playwright install chromium`.
set -e
cd "$(dirname "$0")/../.."

PORT="${PERF_PORT:-1426}"
OUT="${PERF_OUT:-/tmp/frontend-perf.json}"

echo "building (vite --mode perf)…"
corepack pnpm exec vite build --mode perf >/dev/null

echo "serving on :$PORT…"
corepack pnpm exec vite preview --port "$PORT" --strictPort --outDir dist >/dev/null 2>&1 &
PREVIEW_PID=$!
trap 'kill "$PREVIEW_PID" 2>/dev/null || true; rm -rf dist' EXIT

# wait for the server to answer
i=0
while [ "$i" -lt 20 ]; do
  if curl -s -o /dev/null "http://localhost:$PORT"; then break; fi
  i=$((i + 1)); sleep 0.5
done

PERF_URL="http://localhost:$PORT" PERF_OUT="$OUT" node scripts/qa/frontend-perf.mjs
