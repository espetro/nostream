import { Knex } from 'knex'

/**
 * Storage-dialect helpers for the dual Postgres/SQLite backend.
 *
 * DB_CLIENT selects the event-store dialect:
 *   - 'pg' (default): PostgreSQL, unchanged upstream behavior
 *   - 'sqlite' | 'sqlite3' | 'better-sqlite3': embedded SQLite via better-sqlite3
 *
 * CACHE_DRIVER (see src/cache/client.ts) independently selects the
 * Redis-vs-SQLite cache/fanout backend.
 */

export const SQLITE_KNEX_CLIENT = 'better-sqlite3'

export const isSqliteDbClientName = (name?: string): boolean => {
  const normalized = (name ?? '').trim().toLowerCase()
  return normalized === 'sqlite' || normalized === 'sqlite3' || normalized === SQLITE_KNEX_CLIENT
}

export const getDbClientName = (): string => process.env.DB_CLIENT?.trim().toLowerCase() || 'pg'

export const isSqliteDb = (): boolean => isSqliteDbClientName(getDbClientName())

export const getDbFile = (): string => process.env.DB_FILE?.trim() || './data/nostream.db'

/** Detects the dialect of an already-built knex instance. */
export const isSqliteClient = (client: Knex): boolean => {
  const clientName = client?.client?.config?.client
  return clientName === 'sqlite3' || clientName === SQLITE_KNEX_CLIENT
}

/** Portable "current timestamp" expression for UPDATE statements. */
export const nowExpression = (client: Knex): Knex.Raw =>
  isSqliteClient(client) ? client.raw("datetime('now')") : client.raw('now()')
