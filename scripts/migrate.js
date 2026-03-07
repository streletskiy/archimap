require('dotenv').config({ quiet: true });

const path = require('path');
const { initDbBootstrapInfra } = require('../src/lib/server/infra/db-bootstrap.infra');
const { runPendingPostgresMigrations } = require('../src/lib/server/infra/postgres-migrations.infra');
const { createLogger } = require('../src/lib/server/services/logger.service');
const { ensureAuthSchema } = require('../src/lib/server/auth');
const { getDbProvider, getPostgresConnectionString } = require('./lib/postgres-config');

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  service: 'archimap-migrate'
});

async function runSqliteMigrations() {
  const Database = require('better-sqlite3');
  const dataDir = path.join(__dirname, '..', 'data');
  const dbPath = String(process.env.ARCHIMAP_DB_PATH || path.join(dataDir, 'archimap.db')).trim() || path.join(dataDir, 'archimap.db');
  const osmDbPath = String(process.env.OSM_DB_PATH || path.join(dataDir, 'osm.db')).trim() || path.join(dataDir, 'osm.db');
  const localEditsDbPath = String(process.env.LOCAL_EDITS_DB_PATH || path.join(dataDir, 'local-edits.db')).trim() || path.join(dataDir, 'local-edits.db');
  const userEditsDbPath = String(process.env.USER_EDITS_DB_PATH || path.join(dataDir, 'user-edits.db')).trim() || path.join(dataDir, 'user-edits.db');
  const userAuthDbPath = String(process.env.USER_AUTH_DB_PATH || path.join(dataDir, 'users.db')).trim() || path.join(dataDir, 'users.db');
  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');

  const runtime = initDbBootstrapInfra({
    Database,
    dbPath,
    osmDbPath,
    localEditsDbPath,
    userEditsDbPath,
    userAuthDbPath,
    ensureAuthSchema,
    migrationsDir,
    logger
  });

  try {
    logger.info('migrations_done', {
      provider: 'sqlite',
      dbPath,
      osmDbPath,
      localEditsDbPath,
      userEditsDbPath,
      userAuthDbPath,
      migrationsDir
    });
  } finally {
    runtime.db.close();
  }
}

async function runPostgresMigrations() {
  const connectionString = getPostgresConnectionString(process.env);
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for DB_PROVIDER=postgres');
  }
  const migrationsDir = path.join(__dirname, '..', 'db', 'postgres', 'migrations');
  await runPendingPostgresMigrations({ connectionString, migrationsDir, logger });
  logger.info('migrations_done', { provider: 'postgres', migrationsDir });
}

async function main() {
  const provider = getDbProvider(process.env);
  if (provider === 'postgres') {
    await runPostgresMigrations();
    return;
  }
  await runSqliteMigrations();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('migrations_failed', { error: String(error?.message || error) });
    process.exit(1);
  });
