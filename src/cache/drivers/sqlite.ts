import { CacheClient } from '../../@types/cache'
import { createLogger } from '../../factories/logger-factory'
import { SqliteCacheClient } from '../sqlite-cache'
import { CacheDriver } from './types'

const logger = createLogger('cache-client')

export const getCacheFile = (): string =>
  process.env.CACHE_FILE?.trim() || process.env.DB_FILE?.trim() || './data/nostream.db'

/**
 * Embedded SQLite cache driver (CACHE_DRIVER=sqlite). The client implements
 * the node-redis subset the codebase uses (strings, sets, hashes, sorted
 * sets, streams, script dispatch), so every consumer — RedisAdapter and the
 * relay broadcast fanout alike — works unchanged. CACHE_FILE defaults to
 * DB_FILE so a zero-daemon deployment keeps everything in one file.
 */
export const sqliteCacheDriver: CacheDriver = {
  name: 'sqlite',

  createClient: (): CacheClient => {
    const file = getCacheFile()
    logger('driver: sqlite file=%s', file)
    return new SqliteCacheClient(file) as unknown as CacheClient
  },
}
