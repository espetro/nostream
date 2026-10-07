import 'pg'
import 'pg-query-stream'
import knex, { Knex } from 'knex'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from '../factories/logger-factory'
import { getDbFile, isSqliteDb, SQLITE_KNEX_CLIENT } from './dialect'

const poolLogger = createLogger('database-client:pool-monitor')

;((knex) => {
  const lastUpdate = {}
  knex.Client.prototype.releaseConnection = function (connection) {
    const released = this.pool.release(connection)

    if (released) {
      const now = new Date().getTime()
      const { tag } = this.config
      lastUpdate[tag] = lastUpdate[tag] ?? now
      if (now - lastUpdate[tag] >= 60000) {
        lastUpdate[tag] = now
        poolLogger.info(`${tag} connection pool: ${this.pool.numUsed()} used / ${this.pool.numFree()} free / ${this.pool.numPendingAcquires()} pending`)
      }
    }

    return Promise.resolve()
  }
})(knex)

const getSqliteMasterConfig = (): Knex.Config => {
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
      // WAL lets every clustered worker process share the one database file:
      // concurrent readers plus a single serialized writer.
      afterCreate: (connection: any, done: (err?: Error, conn?: any) => void) => {
        connection.pragma('journal_mode = WAL')
        connection.pragma('synchronous = NORMAL')
        connection.pragma('busy_timeout = 10000')
        connection.pragma('foreign_keys = ON')
        done(undefined, connection)
      },
    },
  } as any
}

const getMasterConfig = (): Knex.Config => {
  if (isSqliteDb()) {
    return getSqliteMasterConfig()
  }

  return {
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
  } as any
}

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

const getReadReplicaConfig = (): Knex.Config => {
  const readReplicaIndex = Number(process.env.WORKER_INDEX) % Number(process.env.READ_REPLICAS)
  return getReadReplicaConfigByIndex(readReplicaIndex)
}

let writeClient: Knex

export const getMasterDbClient = () => {
  const logger = createLogger('database-client:get-db-client')
  if (!writeClient) {
    const config = getMasterConfig()
    logger('config: %o', config)
    writeClient = knex(config)
  }

  return writeClient
}

let readClient: Knex

export const getReadReplicaDbClient = () => {
  // SQLite has no replicas; reads share the embedded connection.
  if (isSqliteDb() || process.env.READ_REPLICA_ENABLED !== 'true') {
    return getMasterDbClient()
  }

  const logger = createLogger('database-client:get-read-replica-db-client')
  if (!readClient) {
    const config = getReadReplicaConfig()
    logger('config: %o', config)
    readClient = knex(config)
  }

  return readClient
}
