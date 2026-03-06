#!/usr/bin/env node
require('dotenv').config({ quiet: true });

const path = require('path');
const { createLogger } = require('../src/lib/server/services/logger.service');
const { getPostgresConnectionString } = require('./lib/postgres-config');
const { runPendingPostgresMigrations } = require('../src/lib/server/infra/postgres-migrations.infra');

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  service: 'archimap-postgres-migrate'
});

const migrationsDir = path.join(__dirname, '..', 'db', 'postgres', 'migrations');

async function run() {
  const connectionString = getPostgresConnectionString(process.env);
  await runPendingPostgresMigrations({ connectionString, migrationsDir, logger });
  logger.info('pg_migrations_done', { migrationsDir });
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('pg_migrations_failed', { error: String(error?.message || error) });
    process.exit(1);
  });
