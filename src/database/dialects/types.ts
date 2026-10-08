import { Knex } from 'knex'

import { DatabaseClient } from '../../@types/base'

/**
 * Storage-dialect adapter contract.
 *
 * Everything a storage backend needs to supply lives behind this interface so
 * alternative backends (see https://github.com/Cameri/nostream/issues/147) can
 * be provided without changing repository code — including by community
 * packages loaded via the DB_ADAPTER env var, which keep zero maintenance
 * surface inside this repository.
 *
 * The bundled implementations are `postgres` (the default, upstream behavior)
 * and `sqlite` (embedded single-file mode). A community adapter is any module
 * exporting `createStorageDialect(): StorageDialect`.
 */
export interface StorageDialect {
  /** Adapter name; matched against DB_CLIENT (built-ins) for selection. */
  readonly name: string

  /** knex `client` driver values produced by this adapter (detection). */
  readonly clientNames: readonly string[]

  /** knex config for the write/master connection. */
  masterConfig(): Knex.Config

  /** knex config for a read replica, or null when the backend has none. */
  readReplicaConfig(): Knex.Config | null

  /** Migrations directory for `knex migrate` (used by knexfile.js). */
  readonly migrationsDirectory: string

  /** Seeds directory for `knex seed` (used by knexfile.js). */
  readonly seedsDirectory?: string

  /** "Current timestamp" SQL expression for UPDATE statements. */
  nowExpression(client: Knex): Knex.Raw

  /**
   * NIP-50: SELECT-list extension producing a `search_rank` column, ordered
   * so that higher is better. `language` is the relay's configured
   * text-search language (dialects that don't use it may ignore it).
   */
  searchSelection(client: Knex, searchQuery: string, language: string): Knex.Raw

  /** NIP-50: adds the row filter matching `searchQuery` to the builder. */
  applySearchFilter(builder: Knex.QueryBuilder, searchQuery: string, language: string): void

  /**
   * Adds an OR-ed "column starts with hex prefix" condition for a blob/bytea
   * column. `prefix` is a lower-case hex string; even-length prefixes map to
   * whole bytes, odd-length prefixes to a half-byte range.
   */
  applyHexPrefix(builder: Knex.QueryBuilder, tableField: string, prefix: string): void

  /**
   * Prepares an INSERT/UPSERT query so its result reports rows actually
   * written (needed on backends where conflict-ignored statements would
   * otherwise report a rowid instead of a count).
   */
  applyWriteReturning(query: Knex.QueryBuilder): Knex.QueryBuilder

  /** Normalizes a write query's raw result into an affected-row count. */
  toRowCount(result: unknown): number

  /**
   * Applies a row-claim lock for queue-style consumers
   * (FOR UPDATE SKIP LOCKED on backends that support it; no-op otherwise —
   * single-writer backends are already serialized).
   */
  applyClaimLock(query: Knex.QueryBuilder): Knex.QueryBuilder

  /** Raw statements that empty the event store (truncate/delete). */
  truncateEventsStatements(hasEventTags: boolean): string[]

  /** Optional raw statement run after selective event deletes. */
  vacuumEventsStatement(): string | null

  /**
   * Admits a user (Postgres keeps this as the admit_user() function;
   * other backends port it).
   */
  admitUser(client: DatabaseClient, pubkey: string, admittedAt: Date): Promise<void>

  /**
   * Confirms an invoice and credits the payee's balance
   * (Postgres confirm_invoice() function; other backends port it).
   */
  confirmInvoice(
    client: DatabaseClient,
    invoiceId: string,
    amountPaid: bigint,
    confirmedAt: Date,
  ): Promise<void>
}
