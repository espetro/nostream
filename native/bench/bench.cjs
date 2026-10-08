// Benchmarks nostream-validate: scriptc native binary vs the same code under Node.
//
// Modes:
//   native  native/dist/nostream-validate          (scriptc, static ELF)
//   node    node native/bench/out/node/cli.js       (tsc-compiled, zero deps)
//   tsnode  node -r ts-node/register/transpile-only (dev-loop baseline)
//
// Metrics per mode: single-invocation latency p50/p95 (spawn-bound — what a
// CLI per-event pipeline pays), batch throughput via --batch stdin (compute
// isolation), peak RSS of the batch run, artifact footprint.
//
// Usage: node native/bench/bench.cjs [--events 2000] [--shots 80]
const { spawnSync, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const N_EVENTS = parseInt(arg('events', '2000'), 10)
const N_SHOTS = parseInt(arg('shots', '80'), 10)

const ROOT = path.join(__dirname, '..', '..')
const OUT = path.join(__dirname, 'out')
const CORPUS = path.join(OUT, 'corpus.jsonl')
const FILTERS = fs.readdirSync(OUT).filter((f) => /^filter\d+\.json$/.test(f)).sort().map((f) => path.join(OUT, f))
const BINARY = path.join(ROOT, 'native', 'dist', 'nostream-validate')
const NODE_CLI = path.join(OUT, 'node', 'cli.js')
const TS_NODE = require.resolve('ts-node/register/transpile-only', { paths: [ROOT] })

const corpusText = fs.readFileSync(CORPUS, 'utf8')
const corpus = corpusText.trim().split('\n')
const filterArgs = FILTERS.flatMap((f) => ['--filter', f])

const modes = {
  native: { cmd: [BINARY], cwd: ROOT },
  node: { cmd: [process.execPath, NODE_CLI], cwd: ROOT },
  tsnode: { cmd: [process.execPath, '-r', TS_NODE, path.join(ROOT, 'native', 'src', 'cli.ts')], cwd: ROOT },
}

const pct = (arr, p) => {
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}
const f1 = (x) => Math.round(x * 10) / 10

function timeRun(cmd, args, input) {
  const t0 = performance.now()
  const r = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    input, encoding: 'utf8', cwd: ROOT, maxBuffer: 256 * 1024 * 1024,
  })
  const ms = performance.now() - t0
  if (r.status === null && r.error) throw r.error
  return { ms, status: r.status, stdout: r.stdout }
}

// Single-shot: each invocation validates one event + applies both filters.
function singleShot(mode) {
  const lat = []
  for (let i = 0; i < N_SHOTS; i++) {
    const ev = corpus[i % corpus.length]
    const { ms } = timeRun(modes[mode].cmd, ['-', ...filterArgs], ev)
    lat.push(ms)
  }
  return { p50: f1(pct(lat, 50)), p95: f1(pct(lat, 95)), mean: f1(lat.reduce((a, b) => a + b, 0) / lat.length) }
}

// Batch: one process validates the whole corpus through stdin JSONL.
function batch(mode) {
  const args = ['-', '--batch', ...filterArgs]
  const { ms, status, stdout } = timeRun(modes[mode].cmd, args, corpusText)
  const outLines = stdout.trim().split('\n').length
  if (outLines !== corpus.length) {
    throw new Error(`${mode}: expected ${corpus.length} report lines, got ${outLines} (status ${status})`)
  }
  const validCount = stdout.split('"valid":true').length - 1
  return { ms: Math.round(ms), perEventUs: Math.round((ms * 1000) / corpus.length), eps: Math.round((corpus.length / ms) * 1000), validCount }
}

function peakRssKb(mode) {
  const cmd = modes[mode].cmd
  const args = ['-', '--batch', ...filterArgs]
  const res = spawnSync('/usr/bin/time', ['-v', cmd[0], ...cmd.slice(1), ...args], {
    input: corpusText, encoding: 'utf8', cwd: ROOT, maxBuffer: 256 * 1024 * 1024,
  })
  const m = res.stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

function fileSize(p) { return Math.round(fs.statSync(p).size / 1024) }

const results = {}
for (const mode of Object.keys(modes)) {
  process.stderr.write(`benching ${mode}... `)
  timeRun(modes[mode].cmd, ['--help'], '') // warm page cache
  results[mode] = { single: singleShot(mode), batch: batch(mode), rssKb: peakRssKb(mode) }
  process.stderr.write('done\n')
}

const nodeRuntimeKb = fileSize(process.execPath)
const footprint = {
  native: `${fileSize(BINARY)} KiB binary (static, zero deps)`,
  node: `${fileSize(NODE_CLI) + fileSize(path.join(OUT, 'node', 'event.js')) + fileSize(path.join(OUT, 'node', 'filter.js')) + fileSize(path.join(OUT, 'node', 'schnorr.js')) + fileSize(path.join(OUT, 'node', 'sha256.js')) + fileSize(path.join(OUT, 'node', 'types.js'))} KiB JS + node runtime ${nodeRuntimeKb} KiB`,
  tsnode: 'TS sources + node runtime + ts-node/node_modules',
}

const report = { config: { events: N_EVENTS, shots: N_SHOTS }, results, footprint }
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2))

const row = (m, d) => `| ${m} | ${d.single.p50} | ${d.single.p95} | ${d.batch.eps} | ${d.batch.perEventUs} | ${d.rssKb !== null ? f1(d.rssKb / 1024) : '?'} |`
console.log(`\n| mode | single-shot p50 (ms) | single-shot p95 (ms) | batch ev/s | batch µs/event | batch peak RSS (MiB) |`)
console.log(`|---|---|---|---|---|---|`)
for (const m of Object.keys(modes)) console.log(row(m, results[m]))
console.log(`\nFootprint: native ${footprint.native}; node ${footprint.node}`)
console.log(`Results written to ${path.join(OUT, 'results.json')}`)
