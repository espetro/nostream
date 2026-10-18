// Event storage seam. SqliteEventStore is the only implementation today,
// backed by @cutils/sqlite embedded in the same ELF; the small method
// surface (saveEvent/query) is what a @cutils/postgres adapter would
// implement later — keep storage calls inside this file.

import type { Event, SubscriptionFilter } from '../../src/types'
import { Database } from '../.vendor/sqlite/index.ts'
import type { BindValue } from '../.vendor/sqlite/index.ts'
import { hexToBytes } from './proto'
import { SCHEMA_SQL } from './schema'

// NIP-16 replaceable / NIP-33 parameterized-replaceable kind sets, mirrored
// from the replaceable_events_idx partial index.
const isReplaceableKind = (kind: number): boolean =>
  kind === 0 || kind === 3 || kind === 41 || (kind >= 10000 && kind < 20000)

const isParameterizedReplaceableKind = (kind: number): boolean =>
  kind >= 30000 && kind < 40000

export const isEphemeralKind = (kind: number): boolean =>
  kind >= 20000 && kind < 30000

const firstTagValue = (event: Event, name: string): string => {
  for (let i = 0; i < event.tags.length; i++) {
    const t = event.tags[i]
    if (t.length >= 2 && t[0] === name) {
      return t[1]
    }
  }
  return ''
}

// Mirrors upstream toUpsertRow: parameterized-replaceable events carry the
// 'd' tag; everything else defaults to [pubkey, kind].
const deduplicationOf = (event: Event): string => {
  if (isParameterizedReplaceableKind(event.kind)) {
    return JSON.stringify([event.pubkey, event.kind, firstTagValue(event, 'd')])
  }
  return JSON.stringify([event.pubkey, event.kind])
}

export interface SaveResult {
  stored: boolean
  duplicate: boolean
  stale: boolean
}

interface EventRow {
  event_id: string
  event_pubkey: string
  event_kind: number
  event_created_at: number
  event_content: string
  event_tags: string
  event_signature: string
}

const rowToEvent = (r: EventRow): Event => ({
  id: r.event_id,
  pubkey: r.event_pubkey,
  created_at: r.event_created_at,
  kind: r.event_kind,
  tags: JSON.parse(r.event_tags) as string[][],
  content: r.event_content,
  sig: r.event_signature,
})

export class SqliteEventStore {
  _db: Database
  _maxLimit: number

  constructor(db: Database, maxLimit: number) {
    this._db = db
    this._maxLimit = maxLimit
    this._db.exec(SCHEMA_SQL)
    this._db.exec('PRAGMA journal_mode = WAL')
    this._db.exec('PRAGMA synchronous = NORMAL')
  }

  saveEvent(event: Event, verified: number): SaveResult {
    const dedup = deduplicationOf(event)
    const replaceable =
      isReplaceableKind(event.kind) || isParameterizedReplaceableKind(event.kind)
    const params = [
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
      event.kind,
      event.created_at,
      event.content,
      JSON.stringify(event.tags),
      hexToBytes(event.sig),
      dedup,
      verified,
    ]
    if (replaceable) {
      // NIP-16/33 upsert: newest (created_at, then lowest id) wins, matching
      // upstream's onConflict(...).merge(...).where clause.
      const stmt = this._db.prepareRaw(
        `INSERT INTO events
           (event_id, event_pubkey, event_kind, event_created_at, event_content,
            event_tags, event_signature, event_deduplication, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_pubkey, event_kind, event_deduplication)
           WHERE
             (event_kind = 0 OR event_kind = 3 OR event_kind = 41
              OR (event_kind >= 10000 AND event_kind < 20000))
             OR (event_kind >= 30000 AND event_kind < 40000)
         DO UPDATE SET
           event_id = excluded.event_id,
           event_created_at = excluded.event_created_at,
           event_content = excluded.event_content,
           event_tags = excluded.event_tags,
           event_signature = excluded.event_signature,
           verified = excluded.verified,
           expires_at = NULL
         WHERE events.event_created_at < excluded.event_created_at
            OR (events.event_created_at = excluded.event_created_at
                AND events.event_id > excluded.event_id)`,
      )
      stmt.run(params)
      stmt.finalize()
      if (this._db.changes() === 0) {
        return { stored: false, duplicate: false, stale: true }
      }
      return { stored: true, duplicate: false, stale: false }
    }
    const stmt = this._db.prepareRaw(
      `INSERT OR IGNORE INTO events
         (event_id, event_pubkey, event_kind, event_created_at, event_content,
          event_tags, event_signature, event_deduplication, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    stmt.run(params)
    stmt.finalize()
    if (this._db.changes() === 0) {
      return { stored: false, duplicate: true, stale: false }
    }
    return { stored: true, duplicate: false, stale: false }
  }

  setVerified(id: string, verified: number): void {
    const stmt = this._db.prepareRaw(
      'UPDATE events SET verified = ? WHERE event_id = ?',
    )
    stmt.run([verified, hexToBytes(id)])
    stmt.finalize()
  }

  // Quarantine: retract every not-yet-rejected event from a pubkey whose
  // signature just failed, so one bad actor can't keep a backlog of
  // unverified-but-stored junk.
  quarantinePubkey(pubkey: string): void {
    const stmt = this._db.prepareRaw(
      'UPDATE events SET verified = -1 WHERE event_pubkey = ? AND verified = 0',
    )
    stmt.run([hexToBytes(pubkey)])
    stmt.finalize()
  }

  count(): number {
    const stmt = this._db.prepareRaw(
      'SELECT count(*) AS n FROM events WHERE deleted_at IS NULL',
    )
    const rows = stmt.all([])
    stmt.finalize()
    const row = rows[0] as { n: number }
    return row.n
  }

  // OR over the filter list, each filter AND'd internally — same shape as
  // upstream's query builder. ids/authors are hex-prefix matched on the
  // BLOB columns via hex(...) LIKE, like upstream's prefix search.
  query(filters: SubscriptionFilter[], defaultLimit: number): Event[] {
    const clauses: string[] = []
    const params: BindValue[] = []
    let limit = defaultLimit
    if (limit <= 0 || limit > this._maxLimit) {
      limit = this._maxLimit
    }
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i] as SubscriptionFilter
      const parts: string[] = []
      if ((f.ids as string[]).length > 0) {
        const ids = f.ids as string[]
        const ors: string[] = []
        for (let j = 0; j < ids.length; j++) {
          ors.push("upper(hex(event_id)) LIKE ? || '%'")
          params.push(ids[j].toUpperCase())
        }
        parts.push('(' + ors.join(' OR ') + ')')
      }
      if ((f.authors as string[]).length > 0) {
        const authors = f.authors as string[]
        const ors: string[] = []
        for (let j = 0; j < authors.length; j++) {
          ors.push("upper(hex(event_pubkey)) LIKE ? || '%'")
          params.push(authors[j].toUpperCase())
        }
        parts.push('(' + ors.join(' OR ') + ')')
      }
      if ((f.kinds as number[]).length > 0) {
        const kinds = f.kinds as number[]
        const marks: string[] = []
        for (let j = 0; j < kinds.length; j++) {
          marks.push('?')
          params.push(kinds[j])
        }
        parts.push('event_kind IN (' + marks.join(',') + ')')
      }
      if ((f.since as number) > 0) {
        parts.push('event_created_at >= ?')
        params.push(f.since as number)
      }
      if ((f.until as number) < Number.MAX_SAFE_INTEGER) {
        parts.push('event_created_at <= ?')
        params.push(f.until as number)
      }
      for (const key of Object.keys(f)) {
        if (key.length === 2 && key.charAt(0) === '#') {
          const vals = f[key] as string[]
          if (typeof vals === 'object' && vals !== null && vals.length > 0) {
            const marks: string[] = []
            for (let j = 0; j < vals.length; j++) {
              marks.push('?')
              params.push(vals[j])
            }
            parts.push(
              'EXISTS (SELECT 1 FROM event_tags et WHERE et.event_id = events.event_id AND et.tag_name = ' +
                "'" +
                key.charAt(1) +
                "' AND et.tag_value IN (" +
                marks.join(',') +
                '))',
            )
          }
        }
      }
      if ((f.limit as number) > 0 && (f.limit as number) < limit) {
        limit = f.limit as number
      }
      if (parts.length > 0) {
        clauses.push('(' + parts.join(' AND ') + ')')
      }
    }
    let where = 'deleted_at IS NULL AND verified = 1'
    if (clauses.length > 0) {
      where += ' AND (' + clauses.join(' OR ') + ')'
    }
    const stmt = this._db.prepareRaw(
      `SELECT lower(hex(event_id)) AS event_id,
              lower(hex(event_pubkey)) AS event_pubkey,
              event_kind, event_created_at, event_content, event_tags,
              lower(hex(event_signature)) AS event_signature
       FROM events
       WHERE ` + where + `
       ORDER BY event_created_at DESC, event_id ASC
       LIMIT ?`,
    )
    params.push(limit)
    const rows = stmt.all(params)
    stmt.finalize()
    const out: Event[] = []
    for (let i = 0; i < rows.length; i++) {
      out.push(rowToEvent(rows[i] as EventRow))
    }
    return out
  }
}
