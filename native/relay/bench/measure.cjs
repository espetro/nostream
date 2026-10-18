#!/usr/bin/env node
/**
 * Orchestrates one bench target: spawns the relay, measures cold-start,
 * peaks RSS while load.cjs drives sustained ingest + REQ latency, then
 * prints a merged JSON result.
 *
 *   node measure.cjs --target native|node [--seconds 30] [--sockets 4]
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const WebSocket = require('ws')

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const TARGET = arg('target', 'native')
const PORT = parseInt(arg('port', '8008'), 10)
const SECONDS = arg('seconds', '30')
const SOCKETS = arg('sockets', '4')
const BENCH = __dirname
const CORPUS = path.resolve(BENCH, '../../bench/out/corpus.jsonl')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = {
  native: {
    cwd: path.resolve(BENCH, '../../..'),
    cmd: [path.resolve(BENCH, '../dist/nostream-native')],
    env: {
      RELAY_PORT: String(PORT),
      RELAY_DB_FILE: `/tmp/bench-${TARGET}.db`,
      RELAY_MAX_LIMIT: '500',
      RELAY_SKIP_SIG_VERIFY: '0',
    },
    dbFiles: [`/tmp/bench-${TARGET}.db`],
  },
  node: {
    cwd: '/home/ubuntu/repos/nostream-sqlite',
    cmd: ['pnpm', 'ts-node', 'src/index.ts'],
    env: {
      RELAY_PORT: String(PORT),
      DB_CLIENT: 'sqlite',
      DB_FILE: `./data/bench-${TARGET}.db`,
      CACHE_DRIVER: 'sqlite',
      CACHE_FILE: `./data/bench-${TARGET}.db`,
      WORKER_COUNT: '1',
      RELAY_PRIVATE_KEY: '63'.repeat(32),
      NODE_ENV: 'production',
      NOSTR_CONFIG_DIR: path.resolve(BENCH, 'nostr-config') + '/',
    },
    dbFiles: [`/home/ubuntu/repos/nostream-sqlite/data/bench-${TARGET}.db`],
  },
}

const t = targets[TARGET]
if (!t) {
  console.error('unknown target ' + TARGET)
  process.exit(1)
}

// copy whitelist config for stock relay
if (TARGET === 'node') {
  fs.mkdirSync(path.join(BENCH, 'nostr-config'), { recursive: true })
  fs.writeFileSync(
    path.join(BENCH, 'nostr-config', 'settings.yaml'),
    [
      'limits:',
      '  event:',
      '    whitelists:',
      '      ipAddresses:',
      '        - "::1"',
      '        - "127.0.0.1"',
      '        - "::ffff:127.0.0.1"',
      '  message:',
      '    ipWhitelist:',
      '      - "::1"',
      '      - "127.0.0.1"',
      '      - "::ffff:127.0.0.1"',
      '  connection:',
      '    ipWhitelist:',
      '      - "::1"',
      '      - "127.0.0.1"',
      '      - "::ffff:127.0.0.1"',
      '',
    ].join('\n'),
  )
}

for (const f of t.dbFiles) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(f + suffix)
    } catch {}
  }
}

// Operator step per the ops flow: schema is applied by the knex toolchain
// before the relay boots (stock relay requires it; the native ELF applies
// its own flattened schema at boot instead).
if (TARGET === 'node') {
  execSync('pnpm exec knex migrate:latest', {
    cwd: t.cwd,
    env: { ...process.env, ...t.env },
    stdio: 'inherit',
  })
}

function rssKb(pgid) {
  try {
    const out = execSync(`ps -eo pgid,rss | awk '$1==${pgid}'`, { encoding: 'utf8' })
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .reduce((s, l) => s + parseInt(l.trim().split(/\s+/)[1], 10), 0)
  } catch {
    return 0
  }
}

;(async () => {
  const start = Date.now()
  const child = spawn(t.cmd[0], t.cmd.slice(1), {
    cwd: t.cwd,
    env: { ...process.env, ...t.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d
    if (stderr.length > 8000) stderr = stderr.slice(-8000)
  })
  child.stdout.on('data', () => {})

  let peakRssKb = 0
  const sampler = setInterval(() => {
    const kb = rssKb(child.pid)
    if (kb > peakRssKb) peakRssKb = kb
  }, 400)

  let coldStartMs = -1
  const deadline = start + 120000
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`)
      const to = setTimeout(() => {
        ws.terminate()
        resolve(false)
      }, 1000)
      ws.on('open', () => {
        clearTimeout(to)
        ws.close()
        resolve(true)
      })
      ws.on('error', () => {
        clearTimeout(to)
        resolve(false)
      })
    })
    if (ok) {
      coldStartMs = Date.now() - start
      break
    }
    if (child.exitCode !== null) break
    await sleep(400)
  }
  if (coldStartMs < 0) {
    console.error('relay never came up. stderr tail:\n' + stderr.slice(-3000))
    process.exit(1)
  }

  const load = spawn(
    process.execPath,
    [
      path.join(BENCH, 'load.cjs'),
      '--port', String(PORT),
      '--corpus', CORPUS,
      '--seconds', SECONDS,
      '--sockets', SOCKETS,
      '--warm', '20000',
      '--inflight', '32',
      '--queries', '15',
    ],
    { cwd: path.resolve(BENCH, '../../..'), stdio: ['ignore', 'pipe', 'inherit'] },
  )
  let out = ''
  load.stdout.on('data', (d) => (out += d))
  const code = await new Promise((r) => load.on('exit', r))
  clearInterval(sampler)
  const peakKb = rssKb(child.pid) > peakRssKb ? rssKb(child.pid) : peakRssKb
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {}
  await sleep(2000)
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {}

  if (code !== 0) {
    console.error('load driver failed (' + code + '). relay stderr tail:\n' + stderr.slice(-3000))
    process.exit(1)
  }
  const loadResult = JSON.parse(out.trim())
  const disk = t.dbFiles.reduce((s, f) => {
    let b = 0
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        b += fs.statSync(f + suffix).size
      } catch {}
    }
    return s + b
  }, 0)
  const binary =
    TARGET === 'native' ? fs.statSync(path.resolve(BENCH, '../dist/nostream-native')).size : 0
  console.log(
    JSON.stringify(
      {
        target: TARGET,
        coldStartMs,
        peakRssMb: (peakKb / 1024).toFixed(1),
        diskMb: (disk / 1048576).toFixed(1),
        binaryMb: (binary / 1048576).toFixed(1),
        ...loadResult,
      },
      null,
      2,
    ),
  )
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
