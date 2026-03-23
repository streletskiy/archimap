import * as dotenv from 'dotenv';

dotenv.config({ quiet: true });

const dbProvider = String(process.env.DB_PROVIDER || 'sqlite').trim().toLowerCase();

const config =
  dbProvider === 'postgres'
    ? {
        schema: './db/drizzle/schema.ts',
        out: './db/postgres/migrations-generated',
        dialect: 'postgresql',
        dbCredentials: {
          url: String(process.env.DATABASE_URL || '').trim()
        },
        strict: true,
        verbose: true
      }
    : {
        schema: './db/drizzle/schema.ts',
        out: './db/sqlite/migrations-generated',
        dialect: 'sqlite',
        dbCredentials: {
          url: String(process.env.SQLITE_URL || process.env.DATABASE_PATH || process.env.ARCHIMAP_DB_PATH || 'data/archimap.db').trim()
        },
        strict: true,
        verbose: true
      };

export default config;
