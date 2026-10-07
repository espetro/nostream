import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import Database from 'better-sqlite3'

import { createLogger } from '../factories/logger-factory'

const logger = createLogger('sqlite-cache')

/**
 * Embedded, disk-backed replacement for the Redis client used by nostream's
 * cache adapter and relay-broadcast fanout (CACHE_DRIVER=sqlite).
 *
 * It implements the exact subset of the node-redis v4 API surface the codebase
 * touches — strings with TTL, sorted sets, hashes, sets, streams, and the two
 * rate-limiter Lua scripts (ported to JS and executed inside a SQLite
 * transaction, which plays the same atomicity role the Lua sandbox plays in
 * Redis). Unknown scripts throw loudly instead of being silently misapplied.
 *
 * One file can back every clustered worker process: WAL mode allows concurrent
 * readers and serializes writers, so a multi-process nostream deployment needs
 * no external daemon at all.
 */

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS cache_kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cache_zset (
    k TEXT NOT NULL,
    member TEXT NOT NULL,
    score REAL NOT NULL,
    PRIMARY KEY (k, member)
  );
  CREATE INDEX IF NOT EXISTS cache_zset_score_idx ON cache_zset (k, score);
  CREATE TABLE IF NOT EXISTS cache_hash (
    k TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (k, field)
  );
  CREATE TABLE IF NOT EXISTS cache_set (
    k TEXT NOT NULL,
    member TEXT NOT NULL,
    PRIMARY KEY (k, member)
  );
  CREATE TABLE IF NOT EXISTS cache_stream (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    k TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cache_stream_k_idx ON cache_stream (k, seq);
  CREATE TABLE IF NOT EXISTS cache_expiry (
    k TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cache_expiry_at_idx ON cache_expiry (expires_at);
`

const TYPE_TABLES = ['cache_kv', 'cache_zset', 'cache_hash', 'cache_set', 'cache_stream'] as const

const XREAD_POLL_MS = 50

type SqliteScriptHandler = (keys: string[], args: string[]) => unknown

export class SqliteCacheClient extends EventEmitter {
  private db: Database.Database | undefined
  private readonly scriptShas = new Map<string, SqliteScriptHandler>()
  private open = false

  public constructor(private readonly filename: string) {
    super()
    this.registerScripts()
  }

  public get isOpen(): boolean {
    return this.open
  }

  public get isReady(): boolean {
    return this.open
  }

  public async connect(): Promise<void> {
    if (this.open) {
      return
    }

    if (this.filename !== ':memory:') {
      mkdirSync(dirname(this.filename), { recursive: true })
    }

    this.emit('connect')
    const db = new Database(this.filename)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('busy_timeout = 10000')
    db.exec(SCHEMA_SQL)
    this.db = db
    this.open = true
    logger('opened embedded cache at %s', this.filename)
    this.emit('ready')
  }

  public async disconnect(): Promise<void> {
    this.open = false
    this.db?.close()
    this.db = undefined
    this.emit('end')
  }

  public async quit(): Promise<void> {
    await this.disconnect()
  }

  public async ping(): Promise<string> {
    this.requireDb()
    return 'PONG'
  }

  // -- strings ---------------------------------------------------------------

  public async get(key: string): Promise<string | null> {
    const db = this.requireDb()
    if (this.isExpired(key)) {
      return null
    }
    const row = db.prepare('SELECT v FROM cache_kv WHERE k = ?').get(key) as { v: string } | undefined
    return row?.v ?? null
  }

  public async set(
    key: string,
    value: string,
    options?: { EX?: number; PX?: number; NX?: boolean; XX?: boolean; KEEPTTL?: boolean },
  ): Promise<string | null> {
    const db = this.requireDb()
    if (this.isExpired(key)) {
      this.deleteKey(key)
    }

    const exists = db.prepare('SELECT 1 FROM cache_kv WHERE k = ?').get(key) !== undefined
    if (options?.NX && exists) {
      return null
    }
    if (options?.XX && !exists) {
      return null
    }

    db.prepare('INSERT OR REPLACE INTO cache_kv (k, v) VALUES (?, ?)').run(key, String(value))

    if (typeof options?.EX === 'number' || typeof options?.PX === 'number') {
      const ttlMs = typeof options.EX === 'number' ? options.EX * 1000 : (options?.PX as number)
      this.setExpiry(key, Date.now() + ttlMs)
    } else if (!options?.KEEPTTL) {
      // Redis SET without KEEPTTL clears the TTL.
      db.prepare('DELETE FROM cache_expiry WHERE k = ?').run(key)
    }

    return 'OK'
  }

  public async getDel(key: string): Promise<string | null> {
    const value = await this.get(key)
    if (value !== null) {
      await this.del(key)
    }
    return value
  }

  public async exists(key: string | string[]): Promise<number> {
    this.requireDb()
    const keys = Array.isArray(key) ? key : [key]
    let count = 0
    for (const k of keys) {
      if (!this.isExpired(k) && this.keyExistsAnywhere(k)) {
        count += 1
      }
    }
    return count
  }

  public async del(key: string | string[]): Promise<number> {
    this.requireDb()
    const keys = Array.isArray(key) ? key : [key]
    let deleted = 0
    for (const k of keys) {
      if (this.keyExistsAnywhere(k)) {
        deleted += 1
      }
      this.deleteKey(k)
    }
    return deleted
  }

  public async expire(key: string, seconds: number): Promise<boolean> {
    return this.pExpire(key, seconds * 1000)
  }

  public async pExpire(key: string, ms: number): Promise<boolean> {
    this.requireDb()
    if (!this.keyExistsAnywhere(key)) {
      return false
    }
    this.setExpiry(key, Date.now() + ms)
    return true
  }

  public async ttl(key: string): Promise<number> {
    this.requireDb()
    const row = this.db!.prepare('SELECT expires_at FROM cache_expiry WHERE k = ?').get(key) as
      | { expires_at: number }
      | undefined
    if (!row) {
      return this.keyExistsAnywhere(key) && !this.isExpired(key) ? -1 : -2
    }
    const remaining = Math.ceil((row.expires_at - Date.now()) / 1000)
    return remaining < 0 ? -2 : remaining
  }

  // -- sorted sets -----------------------------------------------------------

  public async zAdd(
    key: string,
    members: { score: number; value: string } | { score: number; value: string }[],
  ): Promise<number> {
    const db = this.requireDb()
    const list = Array.isArray(members) ? members : [members]
    const insert = db.prepare('INSERT OR REPLACE INTO cache_zset (k, member, score) VALUES (?, ?, ?)')
    let added = 0
    const tx = db.transaction(() => {
      for (const { score, value } of list) {
        const existed = db
          .prepare('SELECT 1 FROM cache_zset WHERE k = ? AND member = ?')
          .get(key, String(value)) !== undefined
        insert.run(key, String(value), score)
        if (!existed) {
          added += 1
        }
      }
    })
    tx()
    return added
  }

  /** Index-based ZRANGE (matching node-redis zRange). */
  public async zRange(key: string, start: number, stop: number): Promise<string[]> {
    const db = this.requireDb()
    if (this.isExpired(key)) {
      return []
    }
    const total = (
      db.prepare('SELECT COUNT(*) AS c FROM cache_zset WHERE k = ?').get(key) as { c: number }
    ).c
    const from = start < 0 ? Math.max(0, total + start) : start
    const to = stop < 0 ? total + stop : stop
    if (from > to || from >= total) {
      return []
    }
    return (db
      .prepare('SELECT member FROM cache_zset WHERE k = ? ORDER BY score ASC, member ASC LIMIT ? OFFSET ?')
      .all(key, to - from + 1, from) as { member: string }[]).map((r) => r.member)
  }

  public async zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number> {
    const db = this.requireDb()
    const [lo, loExclusive] = this.parseScoreBound(min)
    const [hi, hiExclusive] = this.parseScoreBound(max)
    const result = db
      .prepare(
        `DELETE FROM cache_zset WHERE k = ? AND score ${loExclusive ? '>' : '>='} ? AND score ${hiExclusive ? '<' : '<='} ?`,
      )
      .run(key, lo, hi)
    return result.changes
  }

  public async zScore(key: string, member: string): Promise<number | null> {
    const db = this.requireDb()
    const row = db
      .prepare('SELECT score FROM cache_zset WHERE k = ? AND member = ?')
      .get(key, String(member)) as { score: number } | undefined
    return row ? row.score : null
  }

  public async zCard(key: string): Promise<number> {
    const db = this.requireDb()
    return (db.prepare('SELECT COUNT(*) AS c FROM cache_zset WHERE k = ?').get(key) as { c: number }).c
  }

  // -- hashes ----------------------------------------------------------------

  public async hSet(
    key: string,
    fieldOrFields: string | Record<string, string | number>,
    value?: string | number,
  ): Promise<number> {
    const db = this.requireDb()
    const entries: [string, string][] =
      typeof fieldOrFields === 'string'
        ? [[fieldOrFields, String(value)]]
        : Object.entries(fieldOrFields).map(([f, v]) => [f, String(v)])

    const upsert = db.prepare('INSERT OR REPLACE INTO cache_hash (k, field, value) VALUES (?, ?, ?)')
    let added = 0
    const tx = db.transaction(() => {
      for (const [field, v] of entries) {
        const existed =
          db.prepare('SELECT 1 FROM cache_hash WHERE k = ? AND field = ?').get(key, field) !== undefined
        upsert.run(key, field, v)
        if (!existed) {
          added += 1
        }
      }
    })
    tx()
    return added
  }

  public async hGet(key: string, field: string): Promise<string | undefined> {
    const db = this.requireDb()
    if (this.isExpired(key)) {
      return undefined
    }
    const row = db.prepare('SELECT value FROM cache_hash WHERE k = ? AND field = ?').get(key, field) as
      | { value: string }
      | undefined
    return row?.value
  }

  public async hGetAll(key: string): Promise<Record<string, string>> {
    const db = this.requireDb()
    if (this.isExpired(key)) {
      return {}
    }
    const rows = db.prepare('SELECT field, value FROM cache_hash WHERE k = ?').all(key) as {
      field: string
      value: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.field, r.value]))
  }

  // -- sets ------------------------------------------------------------------

  public async sAdd(key: string, members: string | string[]): Promise<number> {
    const db = this.requireDb()
    const list = Array.isArray(members) ? members : [members]
    const insert = db.prepare('INSERT OR IGNORE INTO cache_set (k, member) VALUES (?, ?)')
    let added = 0
    const tx = db.transaction(() => {
      for (const member of list) {
        added += insert.run(key, String(member)).changes
      }
    })
    tx()
    return added
  }

  public async sMembers(key: string): Promise<string[]> {
    const db = this.requireDb()
    if (this.isExpired(key)) {
      return []
    }
    return (db.prepare('SELECT member FROM cache_set WHERE k = ?').all(key) as { member: string }[]).map(
      (r) => r.member,
    )
  }

  public async sIsMember(key: string, member: string): Promise<boolean> {
    const db = this.requireDb()
    if (this.isExpired(key)) {
      return false
    }
    return db.prepare('SELECT 1 FROM cache_set WHERE k = ? AND member = ?').get(key, member) !== undefined
  }

  // -- Lua scripts ------------------------------------------------------------
  //
  // nostream ships exactly two Lua scripts (the sliding-window and EWMA rate
  // limiters). They are ported to JS below and run inside a SQLite transaction,
  // preserving the all-or-nothing semantics the Lua sandbox provides in Redis.
  // Anything else throws rather than silently doing the wrong thing.

  public async scriptLoad(script: string): Promise<string> {
    const sha = createHash('sha1').update(script).digest('hex')
    if (!this.scriptShas.has(sha)) {
      const port = this.findScriptPort(script)
      if (!port) {
        throw new Error(`sqlite cache: no port registered for script sha1=${sha}`)
      }
      this.scriptShas.set(sha, port)
    }
    return sha
  }

  public async evalSha(
    sha: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    const handler = this.scriptShas.get(sha)
    if (!handler) {
      throw new Error(`sqlite cache: unknown script sha1=${sha}`)
    }
    const db = this.requireDb()
    return db.transaction(() => handler(options.keys, options.arguments))()
  }

  public async eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    const sha = await this.scriptLoad(script)
    return this.evalSha(sha, options)
  }

  private registerScripts(): void {
    // The script texts are compile-time constants inside
    // src/utils/sliding-window-rate-limiter.ts and src/utils/ewma-rate-limiter.ts;
    // fingerprints let scriptLoad bind them without exporting the constants.
    this.pendingScriptPorts = [
      { fingerprints: [/ZREMRANGEBYSCORE/, /max_rate/], fn: this.slidingWindowRateLimiterScript.bind(this) },
      { fingerprints: [/math\.exp/, /HSET/], fn: this.ewmaRateLimiterScript.bind(this) },
    ]
  }

  private pendingScriptPorts: { fingerprints: RegExp[]; fn: SqliteScriptHandler }[] = []

  private findScriptPort(script: string): SqliteScriptHandler | undefined {
    for (const port of this.pendingScriptPorts) {
      if (port.fingerprints.every((fp) => fp.test(script))) {
        return port.fn
      }
    }
    return undefined
  }

  /** Port of SLIDING_WINDOW_RATE_LIMITER_LUA_SCRIPT (sliding-window-rate-limiter.ts). */
  private slidingWindowRateLimiterScript(keys: string[], args: string[]): number {
    const key = keys[0]
    const [timestamp, period, step, maxRate] = args.map(Number)

    const windowStart = timestamp - period
    const db = this.requireDb()
    db.prepare('DELETE FROM cache_zset WHERE k = ? AND score >= ? AND score <= ?').run(
      key,
      Number.NEGATIVE_INFINITY,
      windowStart,
    )

    const members = (
      db.prepare('SELECT member FROM cache_zset WHERE k = ? ORDER BY score ASC, member ASC').all(key) as {
        member: string
      }[]
    ).map((r) => r.member)

    let hits = 0
    for (const member of members) {
      const match = /^[^:]+:([^:]+)/.exec(member)
      if (match) {
        const entryStep = Number(match[1])
        if (!Number.isNaN(entryStep)) {
          hits += entryStep
        }
      }
    }

    if (hits + step > maxRate) {
      return 1
    }

    const baseMember = `${timestamp}:${step}`
    let member = baseMember
    let counter = 0
    const hasMember = db.prepare('SELECT 1 FROM cache_zset WHERE k = ? AND member = ?')
    while (hasMember.get(key, member) !== undefined) {
      counter += 1
      member = `${baseMember}:${counter}`
    }

    db.prepare('INSERT OR REPLACE INTO cache_zset (k, member, score) VALUES (?, ?, ?)').run(
      key,
      member,
      timestamp,
    )
    this.setExpiry(key, Date.now() + period)

    return 0
  }

  /** Port of the EWMA rate-limit script (ewma-rate-limiter.ts). */
  private ewmaRateLimiterScript(keys: string[], args: string[]): number {
    const key = keys[0]
    const [timestamp, rate, period, step] = args.map(Number)
    const db = this.requireDb()

    const get = (field: string) =>
      (db.prepare('SELECT value FROM cache_hash WHERE k = ? AND field = ?').get(key, field) as
        | { value: string }
        | undefined)?.value

    const rOld = Number(get('rate') ?? 0) || 0
    const tOld = Number(get('timestamp') ?? timestamp) || timestamp

    const deltaT = timestamp - tOld
    const lambda = Math.log(2) / period
    const rNew = rOld * Math.exp(-lambda * deltaT) + step

    const upsert = db.prepare('INSERT OR REPLACE INTO cache_hash (k, field, value) VALUES (?, ?, ?)')
    upsert.run(key, 'rate', String(rNew))
    upsert.run(key, 'timestamp', String(timestamp))
    this.setExpiry(key, Date.now() + Math.ceil(period / 1000) * 1000)

    return rNew > rate ? 1 : 0
  }

  // -- streams (relay broadcast fanout) ---------------------------------------

  public async xAdd(
    key: string,
    id: string,
    fields: Record<string, string>,
    options?: { TRIM?: { strategy?: string; strategyModifier?: string; threshold: number } },
  ): Promise<string> {
    const db = this.requireDb()
    const insert = db.prepare('INSERT INTO cache_stream (k, field, value) VALUES (?, ?, ?)')

    let seq = 0
    const tx = db.transaction(() => {
      for (const [field, value] of Object.entries(fields)) {
        const result = insert.run(key, field, String(value))
        seq = Number(result.lastInsertRowid)
      }
      const threshold = options?.TRIM?.strategy?.toUpperCase() === 'MAXLEN' ? options.TRIM.threshold : 0
      if (threshold > 0) {
        db.prepare(
          'DELETE FROM cache_stream WHERE k = ? AND seq <= (SELECT MAX(seq) FROM cache_stream WHERE k = ?) - ?',
        ).run(key, key, threshold)
      }
    })
    tx()

    return `${seq}-0`
  }

  public async xRead(
    input: { key: string; id: string } | { key: string; id: string }[],
    options?: { COUNT?: number; BLOCK?: number },
  ): Promise<{ name: string; messages: { id: string; message: Record<string, string> }[] }[] | null> {
    const db = this.requireDb()
    const streams = Array.isArray(input) ? input : [input]
    const count = options?.COUNT ?? 32
    const deadline = typeof options?.BLOCK === 'number' ? Date.now() + options.BLOCK : undefined

    const readOnce = () => {
      const result: { name: string; messages: { id: string; message: Record<string, string> }[] }[] = []
      for (const { key, id } of streams) {
        const afterSeq = id === '$' ? Number.MAX_SAFE_INTEGER - 1 : Number(id.split('-')[0]) || 0
        // '$' means "only entries added after this call" — resolve it once.
        const effectiveAfter =
          id === '$'
            ? (db.prepare('SELECT MAX(seq) AS m FROM cache_stream WHERE k = ?').get(key) as { m: number | null })
                .m ?? 0
            : afterSeq
        const rows = db
          .prepare(
            'SELECT seq, field, value FROM cache_stream WHERE k = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
          )
          .all(key, effectiveAfter, count) as { seq: number; field: string; value: string }[]

        if (!rows.length) {
          continue
        }

        const bySeq = new Map<number, Record<string, string>>()
        for (const row of rows) {
          const message = bySeq.get(row.seq) ?? {}
          message[row.field] = row.value
          bySeq.set(row.seq, message)
        }

        result.push({
          name: key,
          messages: [...bySeq.entries()].map(([seq, message]) => ({ id: `${seq}-0`, message })),
        })
      }
      return result.length ? result : null
    }

    // The caller re-issues xRead with the last seen id, so '$' is only seen at
    // stream start; resolve it against the current tail each read.
    const result = readOnce()
    if (result || deadline === undefined) {
      return result
    }

    while (Date.now() < deadline && this.open) {
      await new Promise((resolve) => setTimeout(resolve, XREAD_POLL_MS))
      const polled = readOnce()
      if (polled) {
        return polled
      }
    }

    return null
  }

  public async xInfoStream(key: string): Promise<{
    length: number
    firstEntry: { id: string } | null
    lastEntry: { id: string } | null
  }> {
    const db = this.requireDb()
    const stats = db
      .prepare('SELECT COUNT(*) AS c, MIN(seq) AS first, MAX(seq) AS last FROM cache_stream WHERE k = ?')
      .get(key) as { c: number; first: number | null; last: number | null }

    const distinctMessages = db
      .prepare('SELECT COUNT(DISTINCT seq) AS c FROM cache_stream WHERE k = ?')
      .get(key) as { c: number }

    return {
      length: distinctMessages.c,
      firstEntry: stats.first === null ? null : { id: `${stats.first}-0` },
      lastEntry: stats.last === null ? null : { id: `${stats.last}-0` },
    }
  }

  // -- internals --------------------------------------------------------------

  private requireDb(): Database.Database {
    if (!this.db || !this.open) {
      throw new Error('sqlite cache: client is not connected')
    }
    return this.db
  }

  private keyExistsAnywhere(key: string): boolean {
    const db = this.requireDb()
    return TYPE_TABLES.some(
      (table) => db.prepare(`SELECT 1 FROM ${table} WHERE k = ? LIMIT 1`).get(key) !== undefined,
    )
  }

  private deleteKey(key: string): void {
    const db = this.requireDb()
    const tx = db.transaction(() => {
      for (const table of TYPE_TABLES) {
        db.prepare(`DELETE FROM ${table} WHERE k = ?`).run(key)
      }
      db.prepare('DELETE FROM cache_expiry WHERE k = ?').run(key)
    })
    tx()
  }

  private setExpiry(key: string, expiresAtMs: number): void {
    this.requireDb()
      .prepare('INSERT OR REPLACE INTO cache_expiry (k, expires_at) VALUES (?, ?)')
      .run(key, expiresAtMs)
  }

  private isExpired(key: string): boolean {
    const db = this.requireDb()
    const row = db.prepare('SELECT expires_at FROM cache_expiry WHERE k = ?').get(key) as
      | { expires_at: number }
      | undefined
    if (!row) {
      return false
    }
    if (row.expires_at > Date.now()) {
      return false
    }
    this.deleteKey(key)
    return true
  }

  private parseScoreBound(bound: number | string): [number, boolean] {
    if (typeof bound === 'number') {
      return [bound, false]
    }
    const trimmed = bound.trim()
    if (trimmed === '-inf' || trimmed === '+inf' || trimmed === 'inf') {
      return [trimmed === '-inf' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY, false]
    }
    if (trimmed.startsWith('(')) {
      return [Number(trimmed.slice(1)), true]
    }
    return [Number(trimmed), false]
  }
}
