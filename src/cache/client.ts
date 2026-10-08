import { CacheClient } from '../@types/cache'
import { resolveCacheDriver } from './drivers'

export { getCacheConfig } from './drivers/redis'

/**
 * Builds a fresh cache client via the driver registry (see
 * src/cache/drivers): CACHE_DRIVER picks a bundled driver ('redis' default,
 * 'sqlite' embedded), CACHE_ADAPTER loads a community driver module.
 */
export const createCacheClient = (): CacheClient => resolveCacheDriver().createClient()

let instance: CacheClient | undefined = undefined

export const getCacheClient = (): CacheClient => {
  if (!instance) {
    instance = createCacheClient()
  }

  return instance
}

export const closeCacheClient = async (): Promise<void> => {
  if (instance?.isOpen) {
    await instance.disconnect()
    instance = undefined
  }
}
