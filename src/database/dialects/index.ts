import { Knex } from 'knex'

import { postgresDialect } from './postgres'
import { sqliteDialect } from './sqlite'
import { StorageDialect } from './types'

export type { StorageDialect } from './types'

/**
 * Storage-dialect registry (https://github.com/Cameri/nostream/issues/147).
 *
 * Selection:
 *   - DB_CLIENT=pg|sqlite picks a bundled dialect (default: pg).
 *   - DB_ADAPTER=<module> loads a community adapter: any requireable module
 *     exporting `createStorageDialect(): StorageDialect` (or the dialect as
 *     its default export). Community adapters carry their own migrations and
 *     every dialect-specific behavior, so they need no changes here.
 */

const builtinDialects = (): StorageDialect[] => [postgresDialect, sqliteDialect]

const loadExternalDialect = (specifier: string): StorageDialect => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(specifier)
  const adapter: StorageDialect | undefined =
    typeof mod?.createStorageDialect === 'function' ? mod.createStorageDialect() : mod?.default

  if (!adapter || typeof adapter.masterConfig !== 'function') {
    throw new Error(
      `storage adapter module '${specifier}' must export createStorageDialect() or a StorageDialect default export`,
    )
  }

  return adapter
}

let resolved: StorageDialect | undefined

export const resolveStorageDialect = (): StorageDialect => {
  if (resolved) {
    return resolved
  }

  const adapterSpecifier = process.env.DB_ADAPTER?.trim()
  if (adapterSpecifier) {
    resolved = loadExternalDialect(adapterSpecifier)
    return resolved
  }

  const name = (process.env.DB_CLIENT?.trim().toLowerCase() || 'pg')
  resolved = builtinDialects().find((dialect) => dialect.clientNames.includes(name))
  if (!resolved) {
    throw new Error(`unknown DB_CLIENT '${name}' — expected one of: pg, sqlite (or set DB_ADAPTER to a module)`)
  }

  return resolved
}

/**
 * Detects the dialect an already-built knex instance uses, by its configured
 * client driver. Falls back to the resolved (env-selected) dialect.
 */
export const detectStorageDialect = (client: Knex): StorageDialect => {
  const clientName: string | undefined = client?.client?.config?.client
  if (clientName) {
    for (const dialect of [...builtinDialects(), resolved].filter(
      (dialect): dialect is StorageDialect => dialect !== undefined,
    )) {
      if (dialect.clientNames.includes(clientName)) {
        return dialect
      }
    }
  }

  return resolveStorageDialect()
}
