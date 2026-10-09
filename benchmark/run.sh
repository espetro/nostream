#!/usr/bin/env bash
# Runs the daemon-free benchmark for both modes and prints a comparison.
#
#   benchmark/run.sh [events] [queries]
#
# Requires docker (postgres:15 + redis:7.0.5-alpine3.16 get pulled/started as
# bench-pg / bench-redis on localhost) and pnpm install already done.
set -euo pipefail
cd "$(dirname "$0")/.."

EVENTS=${1:-1000}
QUERIES=${2:-15}

PG_ENV="DB_HOST=localhost DB_PORT=5432 DB_USER=nostr_ts_relay DB_PASSWORD=nostr_ts_relay DB_NAME=nostr_ts_relay"

reset_pg() {
  docker rm -f bench-pg bench-redis >/dev/null 2>&1 || true
  docker run -d --name bench-pg \
    -e POSTGRES_DB=nostr_ts_relay -e POSTGRES_USER=nostr_ts_relay -e POSTGRES_PASSWORD=nostr_ts_relay \
    -p 5432:5432 postgres:15 >/dev/null
  docker run -d --name bench-redis -p 6379:6379 \
    redis:7.0.5-alpine3.16 redis-server --loglevel warning --requirepass nostr_ts_relay >/dev/null
  for i in $(seq 1 60); do
    docker exec bench-pg pg_isready -U nostr_ts_relay >/dev/null 2>&1 && break
    sleep 1
  done
  for i in $(seq 1 30); do
    docker exec bench-redis redis-cli -a nostr_ts_relay ping 2>/dev/null | grep -q PONG && break
    sleep 1
  done
  env $PG_ENV pnpm exec knex migrate:latest >/dev/null
}

echo "=== mode: pg (Postgres + Redis daemons) ==="
reset_pg
node benchmark/bench.cjs --mode pg --events "$EVENTS" --queries "$QUERIES" > /tmp/bench-pg.json

echo "=== mode: sqlite (single embedded file) ==="
rm -f data/bench.db*
mkdir -p data
DB_CLIENT=sqlite DB_FILE=./data/bench.db pnpm exec knex migrate:latest >/dev/null
node benchmark/bench.cjs --mode sqlite --events "$EVENTS" --queries "$QUERIES" > /tmp/bench-sqlite.json

node - <<'EOF'
const pg = require('/tmp/bench-pg.json')
const sq = require('/tmp/bench-sqlite.json')
const row = (label, a, b, unit = '') =>
  console.log(`${label.padEnd(34)} ${String(a).padStart(10)} ${String(b).padStart(12)}  ${unit}`)
console.log('\nmetric'.padEnd(34) + 'pg+redis'.padStart(11) + 'sqlite'.padStart(13))
console.log('-'.repeat(70))
row('cold start (ms)', pg.coldStartMs, sq.coldStartMs)
row('total RSS idle (MiB)', pg.memoryMiB.totalIdle, sq.memoryMiB.totalIdle)
row('total RSS loaded (MiB)', pg.memoryMiB.totalLoaded, sq.memoryMiB.totalLoaded)
row('  relay loaded (MiB)', pg.memoryMiB.relayLoaded, sq.memoryMiB.relayLoaded)
row('  daemons loaded (MiB)', Math.round(Object.values(pg.memoryMiB.daemonsLoaded).reduce((a,b)=>a+b,0)), 0)
row('disk (MiB)', (pg.diskBytes/1048576).toFixed(1), (sq.diskBytes/1048576).toFixed(1))
row('ingest (events/s)', pg.ingest.eventsPerSec, sq.ingest.eventsPerSec)
row('OK latency p50 (ms)', pg.ingest.okLatencyMs.p50, sq.ingest.okLatencyMs.p50)
row('OK latency p95 (ms)', pg.ingest.okLatencyMs.p95, sq.ingest.okLatencyMs.p95)
for (const k of Object.keys(pg.queryLatencyMs)) {
  row(`query ${k} p50 (ms)`, pg.queryLatencyMs[k].p50.toFixed(1), sq.queryLatencyMs[k].p50.toFixed(1))
  row(`query ${k} p95 (ms)`, pg.queryLatencyMs[k].p95.toFixed(1), sq.queryLatencyMs[k].p95.toFixed(1))
}
EOF

echo "(raw: /tmp/bench-pg.json /tmp/bench-sqlite.json)"
