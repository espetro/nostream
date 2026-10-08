import { Knex } from 'knex'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { prop } from 'ramda'

import { DatabaseClient } from '../../@types/base'
import { toBuffer } from '../../utils/transform'
import { StorageDialect } from './types'

export const SQLITE_KNEX_CLIENT = 'better-sqlite3'

export const getDbFile = (): string => process.env.DB_FILE?.trim() || './data/nostream.db'

/**
 * Translates a NIP-50 search string into an FTS5 MATCH query. Words are
 * ANDed to approximate plainto_tsquery's semantics; embedded quotes are
 * doubled to stay inside a quoted FTS5 string.
 */
const toFts5Query = (searchQuery: string): string =>
  searchQuery
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' AND ')

/**
 * Balance credit per paid unit, mirroring the Postgres confirm_invoice()
 * function (migrations/20230217_235600_scale_balance_addition_with_unit.js):
 * msats are credited as-is, sats are scaled to msats, btc to msats.
 */
const BALANCE_UNIT_MULTIPLIERS: Record<string, bigint> = {
  msats: 1n,
  sats: 1000n,
  btc: 100000000n * 1000n,
}

/**
 * Embedded SQLite dialect (better-sqlite3). Selected with DB_CLIENT=sqlite;
 * the event store lives in a single file at DB_FILE. WAL mode plus a
 * max-1-pool writer gives every clustered worker shared read access with a
 * serialized writer. There are no read replicas — reads share the master.
 */
export const sqliteDialect: StorageDialect = {
  name: 'sqlite',

  clientNames: [SQLITE_KNEX_CLIENT, 'sqlite3', 'sqlite'],

  masterConfig: (): Knex.Config => {
    const filename = getDbFile()

    if (filename !== ':memory:') {
      mkdirSync(dirname(filename), { recursive: true })
    }

    return {
      tag: 'master',
      client: SQLITE_KNEX_CLIENT,
      connection: { filename },
      useNullAsDefault: true,
      pool: {
        min: 0,
        max: 1,
        idleTimeoutMillis: 60000,
        afterCreate: (connection: any, done: (err?: Error, conn?: any) => void) => {
          connection.pragma('journal_mode = WAL')
          connection.pragma('synchronous = NORMAL')
          connection.pragma('busy_timeout = 10000')
          connection.pragma('foreign_keys = ON')
          done(undefined, connection)
        },
      },
    } as any
  },

  readReplicaConfig: (): Knex.Config | null => null,

  migrationsDirectory: './migrations-sqlite',

  nowExpression: (client: Knex): Knex.Raw => client.raw("datetime('now')"),

  // bm25 returns negative scores (smaller = better); negate so DESC ordering
  // matches Postgres ts_rank semantics.
  searchSelection: (client: Knex, searchQuery: string): Knex.Raw =>
    client.raw(
      'events.*, (SELECT -bm25(events_fts) FROM events_fts WHERE events_fts MATCH ? AND events_fts.rowid = events.rowid) AS search_rank',
      [toFts5Query(searchQuery)],
    ),

  applySearchFilter: (builder: Knex.QueryBuilder, searchQuery: string): void => {
    builder.andWhereRaw('events.rowid IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)', [
      toFts5Query(searchQuery),
    ])
  },

  applyHexPrefix: (builder: Knex.QueryBuilder, tableField: string, prefix: string): void => {
    if (prefix.length % 2 === 0) {
      builder.orWhereRaw(`substr("${tableField}", 1, ?) = ?`, [prefix.length >> 1, toBuffer(prefix)])
    } else {
      builder.orWhereRaw(`substr("${tableField}", 1, ?) BETWEEN ? AND ?`, [
        (prefix.length >> 1) + 1,
        toBuffer(`${prefix}0`),
        toBuffer(`${prefix}f`),
      ])
    }
  },

  // better-sqlite3 resolves conflict-ignored writes to the last rowid instead
  // of a count; RETURNING reports the rows actually written.
  applyWriteReturning: (query: Knex.QueryBuilder): Knex.QueryBuilder => query.returning('id'),

  toRowCount: (result: unknown): number => {
    if (Array.isArray(result)) {
      return result.length
    }
    return (prop('rowCount')(result as { rowCount?: number }) as number | undefined) ?? 0
  },

  // SQLite serializes writers already; FOR UPDATE/SKIP LOCKED don't exist.
  applyClaimLock: (query: Knex.QueryBuilder): Knex.QueryBuilder => query,

  truncateEventsStatements: (hasEventTags: boolean): string[] =>
    hasEventTags ? ['DELETE FROM event_tags;', 'DELETE FROM events;'] : ['DELETE FROM events;'],

  vacuumEventsStatement: (): string => 'VACUUM;',

  // Port of the Postgres admit_user() function
  // (migrations/20260409201624_admit_user_func.js).
  admitUser: async (client: DatabaseClient, pubkey: string, admittedAt: Date): Promise<void> => {
    const now = new Date()
    await client('users')
      .insert({
        pubkey: toBuffer(pubkey),
        is_admitted: true,
        tos_accepted_at: admittedAt,
        created_at: now,
        updated_at: now,
      })
      .onConflict('pubkey')
      .merge({
        is_admitted: true,
        tos_accepted_at: admittedAt,
        updated_at: now,
      })
  },

  // Port of the Postgres confirm_invoice() function (see
  // migrations/20230220_002700_fix_unit_confirm_invoice_func.js): only a
  // not-yet-confirmed invoice confirms and credits the payee.
  confirmInvoice: async (
    client: DatabaseClient,
    invoiceId: string,
    amountPaid: bigint,
    confirmedAt: Date,
  ): Promise<void> => {
    await client.transaction(async (trx) => {
      const invoice = await trx('invoices').where('id', invoiceId).first('pubkey', 'confirmed_at', 'unit')

      if (!invoice || invoice.confirmed_at !== null) {
        return
      }

      await trx('invoices').where('id', invoiceId).update({
        confirmed_at: confirmedAt,
        amount_paid: amountPaid.toString(),
        updated_at: new Date(),
      })

      const multiplier = BALANCE_UNIT_MULTIPLIERS[invoice.unit] ?? 1n
      await trx('users')
        .where('pubkey', invoice.pubkey)
        .update({ balance: trx.raw('balance + ?', [(amountPaid * multiplier).toString()]) })
    })
  },
}
