#!/usr/bin/env bash
# Runs the scriptc-vs-node benchmark for nostream-validate.
# Prereqs: pnpm install; builds the native binary + the tsc node baseline,
# generates a signed corpus, then runs bench.cjs.
#
# Usage: bash native/bench/run.sh [events] [shots]
set -euo pipefail
cd "$(dirname "$0")/../.."

EVENTS="${1:-2000}"
SHOTS="${2:-80}"
OUT="native/bench/out"

echo "== building native binary =="
bash scripts/build-native.sh

echo "== building node baseline (tsc, zero deps) =="
rm -rf "$OUT/node"
./node_modules/.bin/tsc native/src/*.ts \
  --outDir "$OUT/node" --module commonjs --target es2019 \
  --moduleResolution node --esModuleInterop --skipLibCheck

echo "== generating corpus ($EVENTS events) =="
node native/bench/gen-corpus.cjs "$EVENTS" "$OUT"

echo "== running bench =="
node native/bench/bench.cjs --events "$EVENTS" --shots "$SHOTS"
