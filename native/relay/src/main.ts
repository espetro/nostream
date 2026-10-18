// nostream-native — a NIP-01 nostr relay compiled to a single ELF by
// scriptc. Vendored @chttp/router + @chttp/ws supply the HTTP/WebSocket
// server (scriptc lowers subclassed package classes only within one source
// graph — see ../vendor.mjs); @cutils/sqlite is compiled in via
// --npm-static + the package's ffi.json manifest, so storage is embedded
// too. No Node.js runtime, no external daemons.
//
// Config (env): RELAY_PORT (8008), RELAY_DB_FILE (relay.db, ":memory:"
// allowed), RELAY_MAX_SUBS (16), RELAY_MAX_FILTERS (8), RELAY_DEFAULT_LIMIT
// (100), RELAY_MAX_LIMIT (500), RELAY_MAX_CONTENT_BYTES (65536),
// RELAY_SKIP_SIG_VERIFY=1 (bench aid — NOT for production).

import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { Database } from '../.vendor/sqlite/index.ts'
import { createRouter } from '../.vendor/router/index.ts'
import { WsRouter } from '../.vendor/ws/index.ts'
import { RelayHandler } from './relay'
import { SqliteEventStore } from './store'

const envNum = (name: string, dflt: number): number => {
  const v = process.env[name]
  if (v === undefined || v === '') {
    return dflt
  }
  const n = parseInt(v, 10)
  if (Number.isNaN(n)) {
    return dflt
  }
  return n
}

const envStr = (name: string, dflt: string): string => {
  const v = process.env[name]
  if (v === undefined || v === '') {
    return dflt
  }
  return v
}

const log = (msg: string): void => {
  console.log('[nostream-native] ' + msg)
}

const port = envNum('RELAY_PORT', 8008)
const dbFile = envStr('RELAY_DB_FILE', 'relay.db')
const skipSig = envStr('RELAY_SKIP_SIG_VERIFY', '0') === '1'

const limits = {
  maxSubsPerConn: envNum('RELAY_MAX_SUBS', 16),
  maxFiltersPerReq: envNum('RELAY_MAX_FILTERS', 8),
  defaultLimit: envNum('RELAY_DEFAULT_LIMIT', 100),
  maxLimit: envNum('RELAY_MAX_LIMIT', 500),
  maxEventContentBytes: envNum('RELAY_MAX_CONTENT_BYTES', 65536),
}

const db =
  dbFile === ':memory:' ? Database.openInMemory() : Database.open(dbFile)
const store = new SqliteEventStore(db, limits.maxLimit)
const handler = new RelayHandler(store, limits, skipSig)

const app = createRouter()
app.get('/', (c) => c.text('nostream-native: nostr relay, connect over ws'))

const ws = new WsRouter()
ws.ws('/', handler)
app.withUpgrade(ws)

const server = app.serve({ port: port })
server.on('upgrade', function (req: IncomingMessage, socket: Socket, head: Buffer): void {
  if (!ws.upgrade(req, socket, head)) {
    socket.destroy()
  }
})

log(
  'listening on :' +
    port +
    ' db=' +
    dbFile +
    ' maxSubs=' +
    limits.maxSubsPerConn +
    ' maxLimit=' +
    limits.maxLimit +
    (skipSig ? ' SIG-VERIFY OFF' : ''),
)
