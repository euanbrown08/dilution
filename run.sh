#!/usr/bin/env bash
# Dilution — one command to verify the maths and open the explorable.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "==> installing dependencies (npm install)"
  npm install --no-fund --no-audit
fi

echo
echo "==> running the engine test suite (hand-worked examples)"
npx vitest run

echo
echo "==> engine report: every bundled scenario, offline and deterministic"
npx vite-node scripts/report.ts

echo
echo "==> timing one full recompute (the 16 ms frame budget)"
npx vite-node scripts/bench.ts

echo
echo "==> starting the explorable on http://localhost:5173  (ctrl-c to stop)"
npx vite
