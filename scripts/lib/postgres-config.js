require('dotenv').config({ quiet: true });

function getDbProvider(env = process.env) {
  return String(env.DB_PROVIDER || 'sqlite').trim().toLowerCase() || 'sqlite';
}

function getPostgresConnectionString(env = process.env) {
  const direct = String(env.DATABASE_URL || '').trim();
  if (direct) return direct;

  const host = String(env.POSTGRES_HOST || env.PGHOST || '').trim();
  const port = Number(env.POSTGRES_PORT || env.PGPORT || 5432);
  const user = String(env.POSTGRES_USER || env.PGUSER || '').trim();
  const password = String(env.POSTGRES_PASSWORD || env.PGPASSWORD || '').trim();
  const dbName = String(env.POSTGRES_DB || env.PGDATABASE || '').trim();

  if (!host || !user || !dbName) return '';
  const authPart = `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`;
  return `postgresql://${authPart}${host}:${port}/${encodeURIComponent(dbName)}`;
}

module.exports = {
  getDbProvider,
  getPostgresConnectionString
};
