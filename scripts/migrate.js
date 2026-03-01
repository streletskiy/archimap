require('dotenv').config({ quiet: true });

const path = require('path');
const Database = require('better-sqlite3');
const { runPendingMigrations } = require('../infra/migrations.infra');
const { createLogger } = require('../services/logger.service');

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  service: 'archimap-migrate'
});

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = String(process.env.ARCHIMAP_DB_PATH || path.join(dataDir, 'archimap.db')).trim() || path.join(dataDir, 'archimap.db');
const localEditsDbPath = String(process.env.LOCAL_EDITS_DB_PATH || path.join(dataDir, 'local-edits.db')).trim() || path.join(dataDir, 'local-edits.db');
const userEditsDbPath = String(process.env.USER_EDITS_DB_PATH || path.join(dataDir, 'user-edits.db')).trim() || path.join(dataDir, 'user-edits.db');
const userAuthDbPath = String(process.env.USER_AUTH_DB_PATH || path.join(dataDir, 'users.db')).trim() || path.join(dataDir, 'users.db');
const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');

function run() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.prepare('ATTACH DATABASE ? AS local').run(localEditsDbPath);
  db.prepare('ATTACH DATABASE ? AS user_edits').run(userEditsDbPath);
  db.prepare('ATTACH DATABASE ? AS auth').run(userAuthDbPath);

  try {
    runPendingMigrations({ db, migrationsDir, logger });
    logger.info('migrations_done', { dbPath, migrationsDir });
  } finally {
    db.close();
  }
}

try {
  run();
  process.exit(0);
} catch (error) {
  logger.error('migrations_failed', { error: String(error?.message || error) });
  process.exit(1);
}
