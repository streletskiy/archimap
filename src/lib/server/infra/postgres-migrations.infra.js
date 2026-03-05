const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function listPostgresMigrationFiles(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs.readdirSync(migrationsDir)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b));
}

async function ensurePostgresMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function runPendingPostgresMigrations({
  connectionString,
  migrationsDir = path.join(__dirname, '..', '..', '..', '..', 'db', 'postgres', 'migrations'),
  logger = console
}) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for PostgreSQL migrations');
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await ensurePostgresMigrationsTable(client);
    const appliedRows = await client.query('SELECT id FROM public.schema_migrations ORDER BY id');
    const applied = new Set(appliedRows.rows.map((row) => String(row?.id || '')));
    const files = listPostgresMigrationFiles(migrationsDir);

    for (const file of files) {
      if (applied.has(file)) continue;
      const migrationSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(migrationSql);
        await client.query(
          'INSERT INTO public.schema_migrations (id, applied_at) VALUES ($1, NOW())',
          [file]
        );
        await client.query('COMMIT');
        logger.info('pg_migration_applied', { id: file });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

module.exports = {
  listPostgresMigrationFiles,
  runPendingPostgresMigrations
};
