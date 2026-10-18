#!/usr/bin/env bash
# Sustained-load comparison: scriptc-compiled native relay vs stock Node relay.
#
#   bench/run.sh [seconds] [sockets]
#
# Requires: native/relay/dist/nostream-native built (see ../build.sh), the
# corpus at ../../bench/out/corpus.jsonl (native/bench/gen-corpus.cjs), and a
# pnpm-installed checkout of the sqlite-adapter branch at
# /home/ubuntu/repos/nostream-sqlite.
set -euo pipefail
cd "$(dirname "$0")"

SECONDS=${1:-30}
SOCKETS=${2:-4}

for target in native node; do
  node measure.cjs --target "$target" --seconds "$SECONDS" --sockets "$SOCKETS" \
    > "/tmp/bench-$target.json"
done

node - <<'EOF'
const nat = require('/tmp/bench-native.json')
const nod = require('/tmp/bench-node.json')
const row = (l, a, b, u='') => console.log(l.padEnd(30) + String(a).padStart(12) + String(b).padStart(12) + '  ' + u)
console.log('\nmetric'.padEnd(30) + 'native(ELF)'.padStart(13) + 'node(ts-node)'.padStart(13))
console.log('-'.repeat(70))
row('sustained ingest ev/s', nat.ingest.eventsPerSec, nod.ingest.eventsPerSec)
row('EVENT OK p50 ms', nat.ingest.okMs.p50, nod.ingest.okMs.p50)
row('EVENT OK p95 ms', nat.ingest.okMs.p95, nod.ingest.okMs.p95)
row('REQ authors p50 ms', nat.queries.by_author.p50.toFixed(1), nod.queries.by_author.p50.toFixed(1))
row('REQ authors p95 ms', nat.queries.by_author.p95.toFixed(1), nod.queries.by_author.p95.toFixed(1))
row('REQ #t p50 ms', nat.queries.by_tag.p50.toFixed(1), nod.queries.by_tag.p50.toFixed(1))
row('REQ #t p95 ms', nat.queries.by_tag.p95.toFixed(1), nod.queries.by_tag.p95.toFixed(1))
row('cold start ms', nat.coldStartMs, nod.coldStartMs)
row('peak RSS MB', nat.peakRssMb, nod.peakRssMb)
row('binary size MB', nat.binaryMb, 'n/a')
row('db size MB (20k ev warm)', nat.diskMb, nod.diskMb)
EOF
