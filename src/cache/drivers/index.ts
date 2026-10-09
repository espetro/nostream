import { CacheClient } from '../../@types/cache'
import { redisCacheDriver } from './redis'
import { sqliteCacheDriver } from './sqlite'
import { CacheDriver } from './types'

export type { CacheDriver } from './types'

/**
 * Cache-driver registry (the cache/fanout counterpart of the storage
 * dialects — see https://github.com/Cameri/nostream/issues/147).
 *
 * Selection:
 *   - CACHE_DRIVER=redis|sqlite picks a bundled driver (default: redis).
 *   - CACHE_ADAPTER=<module> loads a community driver: a module exporting
 *     `createCacheDriver(): CacheDriver`, `createCacheClient(): CacheClient`,
 *     or a CacheDriver default export.
 */

const builtinDrivers = (): CacheDriver[] => [redisCacheDriver, sqliteCacheDriver]

const loadExternalDriver = (specifier: string): CacheDriver => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(specifier)

  if (typeof mod?.createCacheDriver === 'function') {
    return mod.createCacheDriver()
  }
  if (typeof mod?.createCacheClient === 'function') {
    return { name: specifier, createClient: mod.createCacheClient } as CacheDriver
  }
  if (mod?.default && typeof mod.default.createClient === 'function') {
    return mod.default as CacheDriver
  }

  throw new Error(
    `cache adapter module '${specifier}' must export createCacheDriver(), createCacheClient(), or a CacheDriver default`,
  )
}

let resolved: CacheDriver | undefined

export const resolveCacheDriver = (): CacheDriver => {
  if (resolved) {
    return resolved
  }

  const adapterSpecifier = process.env.CACHE_ADAPTER?.trim()
  if (adapterSpecifier) {
    resolved = loadExternalDriver(adapterSpecifier)
    return resolved
  }

  const name = process.env.CACHE_DRIVER?.trim().toLowerCase() || 'redis'
  resolved = builtinDrivers().find((driver) => driver.name === name)
  if (!resolved) {
    throw new Error(`unknown CACHE_DRIVER '${name}' — expected one of: redis, sqlite (or set CACHE_ADAPTER to a module)`)
  }

  return resolved
}
