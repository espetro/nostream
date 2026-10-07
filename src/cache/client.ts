import { createClient, RedisClientOptions } from 'redis'
import { CacheClient } from '../@types/cache'
import { createLogger } from '../factories/logger-factory'
import { SqliteCacheClient } from './sqlite-cache'

const logger = createLogger('cache-client')

/**
 * CACHE_DRIVER selects the cache/fanout backend:
 *   - 'redis' (default): external Redis server (REDIS_URI / REDIS_HOST ...)
 *   - 'sqlite': embedded SQLite store (CACHE_FILE, defaulting to DB_FILE so a
 *     zero-daemon deployment keeps everything in one file)
 */
export const isSqliteCacheDriver = (): boolean =>
  process.env.CACHE_DRIVER?.trim().toLowerCase() === 'sqlite'

export const getCacheFile = (): string =>
  process.env.CACHE_FILE?.trim() || process.env.DB_FILE?.trim() || './data/nostream.db'

const redactRedisUrlCredentials = (url: string): string => {
  try {
    const parsedUrl = new URL(url)

    if (!parsedUrl.username && !parsedUrl.password) {
      return url
    }

    parsedUrl.username = parsedUrl.username ? '***' : ''
    parsedUrl.password = parsedUrl.password ? '***' : ''

    return parsedUrl.toString()
  } catch {
    return url
  }
}

export const getCacheConfig = (): RedisClientOptions => {
  const password = process.env.REDIS_PASSWORD

  if (process.env.REDIS_URI) {
    return {
      url: process.env.REDIS_URI,
      ...(password ? { password } : {}),
    }
  }

  const host = process.env.REDIS_HOST
  const port = process.env.REDIS_PORT

  if (password) {
    const username = process.env.REDIS_USER ?? 'default'

    return {
      url: `redis://${host}:${port}`,
      username,
      password,
    }
  }

  return {
    url: `redis://${host}:${port}`,
  }
}

/**
 * Builds a fresh cache client honoring CACHE_DRIVER. The embedded SQLite
 * client implements the node-redis subset the codebase uses (strings, sets,
 * hashes, sorted sets, streams, script dispatch), so every consumer —
 * RedisAdapter and the relay broadcast fanout alike — works unchanged.
 */
export const createCacheClient = (): CacheClient => {
  if (isSqliteCacheDriver()) {
    const file = getCacheFile()
    logger('driver: sqlite file=%s', file)
    return new SqliteCacheClient(file) as unknown as CacheClient
  }

  const config = getCacheConfig()
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password: _, ...loggableConfig } = config
  logger('config: %o', {
    ...loggableConfig,
    ...(loggableConfig.url ? { url: redactRedisUrlCredentials(loggableConfig.url) } : {}),
  })
  return createClient(config)
}

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
