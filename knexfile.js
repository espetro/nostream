const dialectSpecifier = (process.env.DB_ADAPTER || process.env.DB_CLIENT || 'pg').trim().toLowerCase()

if (['pg', 'postgres', 'postgresql'].includes(dialectSpecifier)) {
  module.exports = {
    client: 'pg',
    connection: process.env.DATABASE_URI ? process.env.DATABASE_URI : {
      host: process.env.DB_HOST ?? 'localhost',
      port: process.env.DB_PORT ?? 5432,
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'nostream',
    },
    seeds: {
      directory: './seeds',
    },
  }
} else {
  // Alternative storage dialect (built-in or community DB_ADAPTER module):
  // the adapter supplies its own client config and migrations directory.
  require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'commonjs' },
  })
  const { resolveStorageDialect } = require('./src/database/dialects')
  const adapter = resolveStorageDialect()

  module.exports = {
    ...adapter.masterConfig(),
    migrations: {
      directory: adapter.migrationsDirectory,
    },
    seeds: {
      directory: adapter.seedsDirectory ?? './seeds',
    },
  }
}
