import { Knex } from 'knex'
import { prop } from 'ramda'

import { DatabaseClient } from '../../@types/base'
import { toBuffer } from '../../utils/transform'
import { StorageDialect } from './types'

const getReadReplicaConfigByIndex = (index: number): Knex.Config =>
  ({
    tag: 'read-replica',
    client: 'pg',
    connection: {
      host: process.env[`RR${index}_DB_HOST`],
      port: Number(process.env[`RR${index}_DB_PORT`]),
      user: process.env[`RR${index}_DB_USER`],
      password: process.env[`RR${index}_DB_PASSWORD`],
      database: process.env[`RR${index}_DB_NAME`],
    },
    pool: {
      min: process.env[`RR${index}_DB_MIN_POOL_SIZE`] ? Number(process.env[`RR${index}_DB_MIN_POOL_SIZE`]) : 0,
      max: process.env[`RR${index}_DB_MAX_POOL_SIZE`] ? Number(process.env[`RR${index}_DB_MAX_POOL_SIZE`]) : 3,
      idleTimeoutMillis: 60000,
      propagateCreateError: false,
      acquireTimeoutMillis: process.env[`RR${index}_DB_ACQUIRE_CONNECTION_TIMEOUT`]
        ? Number(process.env[`RR${index}_DB_ACQUIRE_CONNECTION_TIMEOUT`])
        : 60000,
    },
  }) as any

/**
 * The default dialect: PostgreSQL via the `pg` driver. Everything here is the
 * upstream nostream behavior, unchanged.
 */
export const postgresDialect: StorageDialect = {
  name: 'pg',

  clientNames: ['pg', 'postgres', 'postgresql'],

  masterConfig: (): Knex.Config =>
    ({
      tag: 'master',
      client: 'pg',
      connection: process.env.DB_URI
        ? process.env.DB_URI
        : {
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT),
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
          },
      pool: {
        min: process.env.DB_MIN_POOL_SIZE ? Number(process.env.DB_MIN_POOL_SIZE) : 0,
        max: process.env.DB_MAX_POOL_SIZE ? Number(process.env.DB_MAX_POOL_SIZE) : 3,
        idleTimeoutMillis: 60000,
        propagateCreateError: false,
        acquireTimeoutMillis: process.env.DB_ACQUIRE_CONNECTION_TIMEOUT
          ? Number(process.env.DB_ACQUIRE_CONNECTION_TIMEOUT)
          : 60000,
      },
      acquireConnectionTimeout: process.env.DB_ACQUIRE_CONNECTION_TIMEOUT
        ? Number(process.env.DB_ACQUIRE_CONNECTION_TIMEOUT)
        : 60000,
    }) as any,

  readReplicaConfig: (): Knex.Config | null => {
    const readReplicaIndex = Number(process.env.WORKER_INDEX) % Number(process.env.READ_REPLICAS)
    return getReadReplicaConfigByIndex(readReplicaIndex)
  },

  migrationsDirectory: './migrations',

  nowExpression: (client: Knex): Knex.Raw => client.raw('now()'),

  searchSelection: (client: Knex, searchQuery: string, language: string): Knex.Raw =>
    client.raw(
      'events.*, ts_rank(to_tsvector(?::regconfig, event_content), plainto_tsquery(?::regconfig, ?)) AS search_rank',
      [language, language, searchQuery],
    ),

  applySearchFilter: (builder: Knex.QueryBuilder, searchQuery: string, language: string): void => {
    builder.andWhereRaw('to_tsvector(?::regconfig, event_content) @@ plainto_tsquery(?::regconfig, ?)', [
      language,
      language,
      searchQuery,
    ])
  },

  applyHexPrefix: (builder: Knex.QueryBuilder, tableField: string, prefix: string): void => {
    if (prefix.length % 2 === 0) {
      builder.orWhereRaw(`substring("${tableField}" from 1 for ?) = ?`, [prefix.length >> 1, toBuffer(prefix)])
    } else {
      builder.orWhereRaw(`substring("${tableField}" from 1 for ?) BETWEEN ? AND ?`, [
        (prefix.length >> 1) + 1,
        `\\x${prefix}0`,
        `\\x${prefix}f`,
      ])
    }
  },

  applyWriteReturning: (query: Knex.QueryBuilder): Knex.QueryBuilder => query,

  toRowCount: (result: unknown): number => prop('rowCount')(result as { rowCount?: number }) as number,

  applyClaimLock: (query: Knex.QueryBuilder): Knex.QueryBuilder => query.forUpdate().skipLocked(),

  truncateEventsStatements: (hasEventTags: boolean): string[] => [
    hasEventTags
      ? 'TRUNCATE TABLE events, event_tags RESTART IDENTITY CASCADE;'
      : 'TRUNCATE TABLE events RESTART IDENTITY CASCADE;',
  ],

  vacuumEventsStatement: (): string => 'VACUUM ANALYZE events;',

  admitUser: async (client: DatabaseClient, pubkey: string, admittedAt: Date): Promise<void> => {
    await client.raw('select admit_user(?, ?)', [toBuffer(pubkey), admittedAt.toISOString()])
  },

  confirmInvoice: async (
    client: DatabaseClient,
    invoiceId: string,
    amountPaid: bigint,
    confirmedAt: Date,
  ): Promise<void> => {
    await client.raw('select confirm_invoice(?, ?, ?)', [
      invoiceId,
      amountPaid.toString(),
      confirmedAt.toISOString(),
    ])
  },
}
