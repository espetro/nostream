#!/usr/bin/env node
/**
 * nostream daemon-free benchmark: SQLite mode vs stock Postgres+Redis mode.
 *
 * Measures, per mode:
 *   - cold start (spawn -> first WS accept)
 *   - memory footprint (RSS of relay process tree + docker daemons)
 *   - disk usage of the data dir(s)
 *   - EVENT ingest: throughput + per-OK latency percentiles (pipelined)
 *   - REQ query latency: time-to-EOSE percentiles per filter shape
 *
 * Usage:
 *   node benchmark/bench.cjs --mode sqlite|pg --events 1000 --queries 15
 *
 * Requires: ws + @noble/secp256k1 from repo node_modules. For `pg` mode the
 * bench-pg / bench-redis containers must be running (see benchmark/run.sh).
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const WebSocket = require('ws')
const { schnorr } = require('@noble/secp256k1')

const PORT = 8008
const REPO = path.resolve(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const MODE = arg('mode', 'sqlite')
const N_EVENTS = parseInt(arg('events', '1000'), 10)
const N_QUERIES = parseInt(arg('queries', '15'), 10)
const INGEST_CONCURRENCY = parseInt(arg('concurrency', '32'), 10)

// ---------- crypto / event gen ----------
const sha256 = (d) => crypto.createHash('sha256').update(d).digest()
const PRIV = '42'.repeat(32)
const PUB = Buffer.from(schnorr.getPublicKey(PRIV)).toString('hex')

async function signEvent(kind, content, tags, created_at) {
  const base = { pubkey: PUB, created_at, kind, tags, content }
  const payload = JSON.stringify([0, base.pubkey, base.created_at, base.kind, base.tags, base.content])
  base.id = Buffer.from(sha256(new TextEncoder().encode(payload))).toString('hex')
  base.sig = Buffer.from(await schnorr.sign(base.id, PRIV)).toString('hex')
  return base
}

async function genEvents(n) {
  const evs = []
  const now = Math.floor(Date.now() / 1000)
  const batch = 200
  for (let i = 0; i < n; i += batch) {
    const chunk = await Promise.all(
      Array.from({ length: Math.min(batch, n - i) }, (_, j) => {
        const k = i + j
        return signEvent(1, `bench event ${k} ${crypto.randomBytes(8).toString('hex')}`, [['t', 'bench'], ['t', `batch${k % 10}`]], now - (n - k))
      }),
    )
    evs.push(...chunk)
  }
  return evs
}

// ---------- process tree RSS ----------
function relayRSS(rootPid) {
  // Sum RSS (kB) of every pid in the relay's process group.
  try {
    const out = execSync(`ps -eo pid,pgid,rss,comm | awk '$2==${rootPid}'`, { encoding: 'utf8' })
    return out.trim().split('\n').filter(Boolean).reduce((sum, line) => sum + parseInt(line.trim().split(/\s+/)[2], 10), 0)
  } catch {
    return 0
  }
}

function dockerStats() {
  if (MODE !== 'pg') return {}
  try {
    const out = execSync(
      `docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' bench-pg bench-redis`,
      { encoding: 'utf8' },
    )
    const stats = {}
    for (const line of out.trim().split('\n')) {
      const [name, usage] = line.split(' ', 2)
      const m = usage.match(/([\d.]+)\s*(MiB|GiB|KiB)/)
      if (m) stats[name] = m[2] === 'GiB' ? parseFloat(m[1]) * 1024 : m[2] === 'KiB' ? parseFloat(m[1]) / 1024 : parseFloat(m[1])
    }
    return stats
  } catch {
    return {}
  }
}

function diskUsageBytes(target) {
  try {
    const out = execSync(`du -sb ${target} 2>/dev/null`, { encoding: 'utf8' })
    return parseInt(out.split('\t')[0], 10)
  } catch {
    return 0
  }
}

// ---------- relay lifecycle ----------
function relayEnv(mode) {
  const env = {
    ...process.env,
    RELAY_PORT: String(PORT),
    WORKER_COUNT: '1',
    RELAY_PRIVATE_KEY: '63'.repeat(32),
    NODE_ENV: 'production',
    // benchmark/nostr-config/settings.yaml whitelists localhost from rate limits
    NOSTR_CONFIG_DIR: path.join(__dirname, 'nostr-config') + '/',
  }
  if (mode === 'pg') {
    Object.assign(env, {
      DB_HOST: 'localhost', DB_PORT: '5432', DB_USER: 'nostr_ts_relay',
      DB_PASSWORD: 'nostr_ts_relay', DB_NAME: 'nostr_ts_relay',
      REDIS_HOST: 'localhost', REDIS_PORT: '6379', REDIS_PASSWORD: 'nostr_ts_relay',
    })
  } else {
    Object.assign(env, {
      DB_CLIENT: 'sqlite', DB_FILE: './data/bench.db',
      CACHE_DRIVER: 'sqlite', CACHE_FILE: './data/bench.db',
    })
  }
  return env
}

async function startRelay(mode) {
  const start = Date.now()
  const child = spawn('node', ['-r', 'ts-node/register', 'src/index.ts'], {
    cwd: REPO,
    env: relayEnv(mode),
    detached: true, // own process group -> pgid = child.pid
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', () => {})
  // cold start: poll until WS accepts
  let coldStartMs = -1
  const deadline = start + 90000
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`)
      const t = setTimeout(() => { ws.terminate(); resolve(false) }, 1000)
      ws.on('open', () => { clearTimeout(t); ws.close(); resolve(true) })
      ws.on('error', () => { clearTimeout(t); resolve(false) })
    })
    if (ok) { coldStartMs = Date.now() - start; break }
    await sleep(400)
  }
  return { child, coldStartMs }
}

function stopRelay(child) {
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  return sleep(2500).then(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} })
}

// ---------- ws measurement ----------
function percentile(sorted, p) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

async function benchIngest(events) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`)
    const pending = new Map() // id -> sendTs
    const lat = []
    let idx = 0
    const t0 = Date.now()

    const pump = () => {
      while (idx < events.length && pending.size < INGEST_CONCURRENCY) {
        const ev = events[idx++]
        pending.set(ev.id, process.hrtime.bigint())
        ws.send(JSON.stringify(['EVENT', ev]))
      }
      if (idx >= events.length && pending.size === 0) {
        ws.close()
        resolve({ count: events.length, wallMs: Date.now() - t0, lat })
      }
    }

    ws.on('open', pump)
    ws.on('message', (d) => {
      const msg = JSON.parse(d)
      if (msg[0] === 'OK') {
        const sent = pending.get(msg[1])
        if (sent !== undefined) {
          pending.delete(msg[1])
          lat.push(Number(process.hrtime.bigint() - sent) / 1e6)
          if (!msg[2]) console.error('rejected event', msg[1], msg[3])
          pump()
        }
      }
    })
    ws.on('error', reject)
    setTimeout(() => reject(new Error('ingest timeout')), 300000)
  })
}

async function benchQuery(filter, repeats) {
  const lat = []
  for (let i = 0; i < repeats; i++) {
    const ms = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`)
      let t0
      ws.on('open', () => {
        t0 = process.hrtime.bigint()
        ws.send(JSON.stringify(['REQ', `q${i}`, filter]))
      })
      ws.on('message', (d) => {
        const msg = JSON.parse(d)
        if (msg[0] === 'EOSE') { ws.close(); resolve(Number(process.hrtime.bigint() - t0) / 1e6) }
      })
      ws.on('error', reject)
      setTimeout(() => reject(new Error('query timeout')), 60000)
    })
    lat.push(ms)
  }
  lat.sort((a, b) => a - b)
  return { p50: percentile(lat, 50), p95: percentile(lat, 95), min: lat[0], max: lat[lat.length - 1] }
}

// ---------- main ----------
;(async () => {
  console.error(`mode=${MODE} events=${N_EVENTS} queries=${N_QUERIES}`)

  const dataDir = MODE === 'sqlite' ? path.join(REPO, 'data') : null
  const pgDataDir = () => {
    try {
      return parseInt(execSync("docker exec bench-pg du -sb /var/lib/postgresql/data", { encoding: 'utf8' }).split('\t')[0], 10)
    } catch { return 0 }
  }
  const diskBefore = dataDir ? diskUsageBytes(dataDir) : pgDataDir()

  const { child, coldStartMs } = await startRelay(MODE)
  if (coldStartMs < 0) throw new Error('relay never came up')
  await sleep(4000) // settle: maintenance worker, caches warm

  const rssIdleKb = relayRSS(child.pid)
  const daemons = dockerStats()

  const events = await genEvents(N_EVENTS)
  const ingest = await benchIngest(events)
  ingest.lat.sort((a, b) => a - b)

  const rssLoadedKb = relayRSS(child.pid)
  const daemonsLoaded = dockerStats()
  const diskAfter = dataDir ? diskUsageBytes(dataDir) : pgDataDir()

  const queries = {
    recent_kind1: await benchQuery({ kinds: [1], limit: 50 }, N_QUERIES),
    by_author: await benchQuery({ authors: [PUB] }, N_QUERIES),
    by_tag: await benchQuery({ '#t': ['bench'] }, N_QUERIES),
    tag_and_kind: await benchQuery({ kinds: [1], '#t': ['batch3'], limit: 50 }, N_QUERIES),
  }

  const result = {
    mode: MODE,
    coldStartMs,
    events: N_EVENTS,
    ingest: {
      wallMs: ingest.wallMs,
      eventsPerSec: Math.round((N_EVENTS / ingest.wallMs) * 1000),
      okLatencyMs: {
        p50: percentile(ingest.lat, 50).toFixed(1),
        p95: percentile(ingest.lat, 95).toFixed(1),
        p99: percentile(ingest.lat, 99).toFixed(1),
      },
    },
    queryLatencyMs: queries,
    memoryMiB: {
      relayIdle: (rssIdleKb / 1024).toFixed(0),
      relayLoaded: (rssLoadedKb / 1024).toFixed(0),
      daemonsIdle: daemons,
      daemonsLoaded,
      totalIdle: (rssIdleKb / 1024 + Object.values(daemons).reduce((a, b) => a + b, 0)).toFixed(0),
      totalLoaded: (rssLoadedKb / 1024 + Object.values(daemonsLoaded).reduce((a, b) => a + b, 0)).toFixed(0),
    },
    diskBytes: diskAfter - diskBefore,
  }

  await stopRelay(child)
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
})().catch((e) => { console.error('FATAL', e); process.exit(1) })
