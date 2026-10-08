import { CacheClient } from '../../@types/cache'

/**
 * Cache-driver adapter contract (the cache/fanout counterpart of the storage
 * dialects — see https://github.com/Cameri/nostream/issues/147).
 *
 * Selected by CACHE_DRIVER (built-in name) or CACHE_ADAPTER (a community
 * module exporting `createCacheDriver(): CacheDriver`, `createCacheClient()`,
 * or a CacheDriver default export).
 */
export interface CacheDriver {
  /** Driver name; matched against CACHE_DRIVER for built-ins. */
  readonly name: string

  /** Builds a fresh cache client for this driver. */
  createClient(): CacheClient
}
