require('dotenv').config({ quiet: true });

const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { getDbProvider, getPostgresConnectionString } = require('./lib/postgres-config');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

async function seedPostgres() {
  const connectionString = getPostgresConnectionString(process.env);
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for DB_PROVIDER=postgres');
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS auth;');
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth.users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        can_edit INTEGER NOT NULL DEFAULT 0,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_master_admin INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const seedEmail = 'demo-admin@example.test';
    const existing = await client.query('SELECT email FROM auth.users WHERE lower(email) = lower($1)', [seedEmail]);
    if (existing.rowCount > 0) {
      console.log(`Seed user already exists: ${seedEmail}`);
      return;
    }

    await client.query(`
      INSERT INTO auth.users (email, password_hash, first_name, last_name, can_edit, is_admin, is_master_admin)
      VALUES ($1, $2, $3, $4, 1, 1, 1)
    `, [seedEmail, hashPassword('DemoAdmin12345'), 'Demo', 'Admin']);
    console.log(`Seed user created: ${seedEmail} / DemoAdmin12345`);
  } finally {
    await client.end();
  }
}

function seedSqlite() {
  const Database = require('better-sqlite3');
  const userAuthDbPath = String(
    process.env.USER_AUTH_DB_PATH || path.join(process.cwd(), 'data', 'users.db')
  ).trim();

  const db = new Database(userAuthDbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      can_edit INTEGER NOT NULL DEFAULT 0,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_master_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const seedEmail = 'demo-admin@example.test';
  const existing = db.prepare('SELECT email FROM users WHERE lower(email) = lower(?)').get(seedEmail);
  if (existing) {
    console.log(`Seed user already exists: ${seedEmail}`);
    db.close();
    return;
  }

  db.prepare(`
    INSERT INTO users (email, password_hash, first_name, last_name, can_edit, is_admin, is_master_admin)
    VALUES (?, ?, ?, ?, 1, 1, 1)
  `).run(seedEmail, hashPassword('DemoAdmin12345'), 'Demo', 'Admin');
  db.close();
  console.log(`Seed user created: ${seedEmail} / DemoAdmin12345`);
}

async function main() {
  const explicitDbProvider = String(process.env.DB_PROVIDER || '').trim().toLowerCase();
  const explicitUserAuthPath = String(process.env.USER_AUTH_DB_PATH || '').trim();
  const provider = explicitDbProvider || (explicitUserAuthPath ? 'sqlite' : getDbProvider(process.env));
  if (provider === 'postgres') {
    await seedPostgres();
    return;
  }
  seedSqlite();
}

main().catch((error) => {
  console.error(`[db-seed] ${String(error?.message || error)}`);
  process.exit(1);
});
