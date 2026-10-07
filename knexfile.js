const path = require('node:path')
const fs = require('node:fs')

const dbClient = (process.env.DB_CLIENT || 'pg').trim().toLowerCase()
const isSqlite = ['sqlite', 'sqlite3', 'better-sqlite3'].includes(dbClient)

if (isSqlite) {
  const dbFile = process.env.DB_FILE || './data/nostream.db'
  if (dbFile !== ':memory:') {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  }

  module.exports = {
    client: 'better-sqlite3',
    connection: { filename: dbFile },
    useNullAsDefault: true,
    migrations: {
      directory: './migrations-sqlite',
    },
    seeds: {
      directory: './seeds',
    },
  }
} else {
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
}
