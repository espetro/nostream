#!/usr/bin/env node
/**
 * Sustained-load driver for the native relay bench.
 *
 * Phases:
 *   1. connect --sockets WS clients
 *   2. warm store: ingest --warm events once (not timed)
 *   3. sustained ingest: for --seconds, every socket pipelines EVENTs from
 *      the corpus; events/sec + per-OK latency percentiles over the window
 *   4. REQ latency: time-to-EOSE per filter shape, --queries repeats each
 *
 * Usage: node load.cjs --port 8008 --corpus <file> --seconds 30
 *                      [--sockets 4] [--queries 15] [--warm 2000]
 *                      [--inflight 32] [--skip-warm]
 */
const fs = require('fs')
const WebSocket = require('ws')
const { schnorr } = require('@noble/secp256k1')

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const PORT = parseInt(arg('port', '8008'), 10)
const SECONDS = parseFloat(arg('seconds', '30'))
const SOCKETS = parseInt(arg('sockets', '4'), 10)
const QUERIES = parseInt(arg('queries', '15'), 10)
const WARM = parseInt(arg('warm', '2000'), 10)
const INFLIGHT = parseInt(arg('inflight', '32'), 10)
const CORPUS = arg('corpus', null)
const SKIP_WARM = arg('skip-warm', '0') === '1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const percentile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0

const events = CORPUS
  ? fs.readFileSync(CORPUS, 'utf8').trim().split('\n').map(JSON.parse)
  : []
if (!events.length) {
  console.error('no corpus')
  process.exit(1)
}
const firstPub = events[0].pubkey

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

// ---------- sustained ingest ----------
async function ingestPhase() {
  const ws = await openWs()
  const pending = new Map()
  const lat = []
  let sent = 0
  let idx = 0
  const t0 = Date.now()
  const deadline = t0 + SECONDS * 1000

  return await new Promise((resolve, reject) => {
    const pump = () => {
      while (pending.size < INFLIGHT && Date.now() < deadline) {
        const ev = events[idx % events.length]
        idx++
        pending.set(ev.id + ':' + idx, process.hrtime.bigint())
        ws.send(JSON.stringify(['EVENT', ev]))
        sent++
      }
      if (Date.now() >= deadline && pending.size === 0) {
        ws.close()
        resolve({ sent, wallMs: Date.now() - t0, lat })
      }
    }
    pump()
    ws.on('message', (d) => {
      const msg = JSON.parse(d)
      if (msg[0] === 'OK') {
        // match by id — dupes share the event id; pop oldest pending entry
        for (const [k, v] of pending) {
          if (k.startsWith(msg[1] + ':')) {
            pending.delete(k)
            lat.push(Number(process.hrtime.bigint() - v) / 1e6)
            break
          }
        }
        if (!msg[2]) console.error('rejected', msg[1], msg[3])
        pump()
      }
    })
    ws.on('error', reject)
    setTimeout(() => reject(new Error('ingest drain timeout')), SECONDS * 1000 + 30000)
  })
}

// ---------- warm (sequential, untimed) ----------
async function warmPhase() {
  const ws = await openWs()
  const n = Math.min(WARM, events.length)
  let idx = 0
  let done = 0
  return await new Promise((resolve, reject) => {
    const pump = () => {
      while (done < n) {
        ws.send(JSON.stringify(['EVENT', events[idx++]]))
        done++
      }
    }
    let oks = 0
    let rejs = 0
    const hb = setInterval(
      () => console.error(`warm progress oks=${oks} rejs=${rejs}`),
      15000,
    )
    pump()
    ws.on('message', (d) => {
      const msg = JSON.parse(d)
      if (msg[0] === 'OK') {
        if (!msg[2]) {
          rejs++
          if (rejs < 5) console.error('warm rejected', msg[1], msg[3])
        }
        if (++oks >= n) {
          clearInterval(hb)
          ws.close()
          resolve(n)
        }
      } else if (msg[0] === 'NOTICE' || msg[0] === 'CLOSED') {
        console.error('warm got', JSON.stringify(msg).slice(0, 200))
      }
    })
    ws.on('error', reject)
    ws.on('close', (code) => {
      if (oks < n) {
        clearInterval(hb)
        reject(new Error(`warm socket closed ${code} after ${oks} OKs`))
      }
    })
    setTimeout(() => {
      clearInterval(hb)
      reject(new Error(`warm timeout oks=${oks} rejs=${rejs}`))
    }, 300000)
  })
}

// ---------- REQ ----------
async function benchQuery(subId, filter, repeats) {
  const lat = []
  const counts = []
  for (let i = 0; i < repeats; i++) {
    const ws = await openWs()
    const r = await new Promise((resolve, reject) => {
      let t0
      let n = 0
      t0 = process.hrtime.bigint()
      ws.send(JSON.stringify(['REQ', subId + i, filter]))
      ws.on('message', (d) => {
        const msg = JSON.parse(d)
        if (msg[0] === 'EVENT') n++
        if (msg[0] === 'EOSE') resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, n })
        if (msg[0] === 'CLOSED') reject(new Error('CLOSED: ' + msg[2]))
        if (msg[0] === 'NOTICE') reject(new Error('NOTICE: ' + msg[1]))
      })
      ws.on('error', reject)
      setTimeout(() => reject(new Error('query timeout')), 60000)
    })
    ws.close()
    lat.push(r.ms)
    counts.push(r.n)
  }
  lat.sort((a, b) => a - b)
  return { p50: percentile(lat, 50), p95: percentile(lat, 95), events: counts[0] }
}

;(async () => {
  console.error(
    `sustained bench: port=${PORT} seconds=${SECONDS} sockets=${SOCKETS} inflight=${INFLIGHT} corpus=${events.length}`,
  )
  if (!SKIP_WARM) {
    const t0 = Date.now()
    await warmPhase()
    console.error(`warm ingest ${Math.min(WARM, events.length)} events in ${Date.now() - t0}ms`)
  }
  const results = await Promise.all(Array.from({ length: SOCKETS }, () => ingestPhase()))
  console.error('ingest done: ' + results.map((r) => r.sent).join('/'))
  const allLat = []
  let total = 0
  let wall = 0
  for (const r of results) {
    allLat.push(...r.lat)
    total += r.sent
    wall = Math.max(wall, r.wallMs)
  }
  allLat.sort((a, b) => a - b)
  const ingest = {
    seconds: (wall / 1000).toFixed(1),
    events: total,
    eventsPerSec: Math.round((total / wall) * 1000),
    okMs: {
      p50: percentile(allLat, 50).toFixed(2),
      p95: percentile(allLat, 95).toFixed(2),
      p99: percentile(allLat, 99).toFixed(2),
    },
  }

  const queries = {
    by_author: await benchQuery('qa', { kinds: [1], authors: [firstPub] }, QUERIES),
    by_tag: await benchQuery('qt', { '#t': ['bench'], kinds: [1] }, QUERIES),
    kind_recent: await benchQuery('qk', { kinds: [1], limit: 50 }, QUERIES),
    since_until: await benchQuery(
      'qs',
      { kinds: [1], since: events[0].created_at, until: events[events.length - 1].created_at, limit: 50 },
      QUERIES,
    ),
  }

  console.log(JSON.stringify({ ingest, queries }, null, 2))
  process.exit(0)
})().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
