// scriptc lowers subclasses of package classes (WsHandler, UpgradeDispatch)
// only when the whole graph is program code — a node_modules dist copy
// fails with "overriding a method with a different signature"
// (chttp docs/websocket.md). This copies the @chttp/router and @chttp/ws
// `src/` trees out of node_modules into .vendor/ and points ws at the
// vendored router, so `scriptc build` sees one source graph.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)))
const repo = resolve(root, '../..')
const out = join(root, '.vendor')

const srcOf = (name) => join(repo, 'node_modules/@chttp', name, 'src')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(srcOf('router'), join(out, 'router'), { recursive: true })
cpSync(srcOf('ws'), join(out, 'ws'), { recursive: true })
// @cutils/sqlite is vendored as program code too: with --npm-static the
// whole graph treats subclassed externals (WsWriter extends Writable) as
// package boundaries and refuses. Its `declare function` block lives in
// src/internal/ffi.ts and binds via --ffi the same way.
cpSync(join(repo, 'node_modules/@cutils/sqlite/src'), join(out, 'sqlite'), { recursive: true })
for (const f of readdirSync(join(out, 'ws'))) {
  if (!f.endsWith('.ts')) continue
  const p = join(out, 'ws', f)
  writeFileSync(p, readFileSync(p, 'utf8').replaceAll('"@chttp/router"', '"../router/index.ts"'))
}

// Vendored patch: upstream's WsWriter subclasses node:stream Writable,
// which scriptc 0.3.6 refuses to lower in this repo's type world
// ("extending classes not declared in the program"). Splice in the
// direct-sink equivalent from ws-writer-patch.txt — the same degradation
// upstream falls back to when the Writable pump can't be observed.
const wsIndex = join(out, 'ws', 'index.ts')
const wsSrc = readFileSync(wsIndex, 'utf8')
const patch = readFileSync(join(root, 'ws-writer-patch.txt'), 'utf8')
const start = wsSrc.indexOf('// Outbound send path for one connection')
const end = wsSrc.indexOf('// Base class for handlers')
if (start < 0 || end < 0 || end <= start) {
  throw new Error('vendor: could not locate WsWriter block to patch')
}
writeFileSync(
  wsIndex,
  wsSrc.slice(0, start) + patch + wsSrc.slice(end).replace('import { Writable } from "node:stream";\n', ''),
)
const withoutStreamImport = readFileSync(wsIndex, 'utf8').replace('import { Writable } from "node:stream";\n', '')
writeFileSync(wsIndex, withoutStreamImport)
console.log('vendored @chttp/router + @chttp/ws + @cutils/sqlite srcs ->', out)
