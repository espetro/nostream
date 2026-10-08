import 'pg'
import 'pg-query-stream'
import knex from 'knex'
import { createLogger } from '../factories/logger-factory'
import { resolveStorageDialect } from './dialects'

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

let writeClient: ReturnType<typeof knex>

export const getMasterDbClient = () => {
  const logger = createLogger('database-client:get-db-client')
  if (!writeClient) {
    const config = resolveStorageDialect().masterConfig()
    logger('config: %o', config)
    writeClient = knex(config)
  }

  return writeClient
}

let readClient: ReturnType<typeof knex>

export const getReadReplicaDbClient = () => {
  // Backends without replicas (e.g. SQLite) share the master connection.
  const readReplicaConfig = resolveStorageDialect().readReplicaConfig()
  if (!readReplicaConfig || process.env.READ_REPLICA_ENABLED !== 'true') {
    return getMasterDbClient()
  }

  const logger = createLogger('database-client:get-read-replica-db-client')
  if (!readClient) {
    logger('config: %o', readReplicaConfig)
    readClient = knex(readReplicaConfig)
  }

  return readClient
}
