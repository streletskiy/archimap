const fs = require('fs');
const path = require('path');

function ensureMigrationsTable(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
}

function listMigrationFiles(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs.readdirSync(migrationsDir)
    .filter((name) => /^\d+.*\.migration\.js$/.test(name))
    .sort((a, b) => a.localeCompare(b));
}

function runPendingMigrations({ db, migrationsDir, logger = console }) {
  ensureMigrationsTable(db);
  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((row) => String(row?.id || ''))
  );
  const files = listMigrationFiles(migrationsDir);

  for (const file of files) {
    const id = String(file || '').trim();
    if (!id || applied.has(id)) continue;
    const absPath = path.join(migrationsDir, file);
    // Ensure latest module body is loaded when running in long-lived process.
    delete require.cache[require.resolve(absPath)];
    const migration = require(absPath);
    if (!migration || typeof migration.up !== 'function') {
      throw new Error(`Invalid migration "${file}": expected { up(db) } export`);
    }

    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime(\'now\'))').run(id);
    });

    tx();
    logger.info('migration_applied', { id });
  }
}

module.exports = {
  runPendingMigrations
};
