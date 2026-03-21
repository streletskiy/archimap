require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { getDbProvider, getPostgresConnectionString } = require('./lib/postgres-config');

function parseArgs(argv = process.argv.slice(2)): LooseRecord {
  const out = {};
  for (const raw of argv) {
    const token = String(raw || '').trim();
    if (!token.startsWith('--')) continue;
    const eqIndex = token.indexOf('=');
    if (eqIndex < 0) {
      out[token.slice(2)] = 'true';
      continue;
    }
    const key = token.slice(2, eqIndex).trim();
    const value = token.slice(eqIndex + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  const email = normalizeEmail(value);
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeProfileName(value, maxLen = 80) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.slice(0, maxLen);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function ensureParentDir(filePath) {
  const target = String(filePath || '').trim();
  if (!target) return;
  const dir = path.dirname(target);
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
}

function ensureUsersSchemaSqlite(db) {
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

  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  const hasMasterAdminColumn = userColumns.some((column) => String(column?.name || '').trim() === 'is_master_admin');
  if (!hasMasterAdminColumn) {
    db.exec('ALTER TABLE users ADD COLUMN is_master_admin INTEGER NOT NULL DEFAULT 0;');
  }
}

async function ensureUsersSchemaPostgres(client) {
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
}

function printUsageAndExit() {
  console.log('Usage: node --import tsx scripts/create-master-admin.ts --email=<email> [--password=<password>] [--first-name=<name>] [--last-name=<name>]');
  console.log('Behavior: creates a new master admin, or promotes existing user to master admin.');
  process.exit(1);
}

function runSqlite({ email, password, firstName, lastName }: LooseRecord) {
  const Database = require('better-sqlite3');
  const userAuthDbPath = String(
    process.env.USER_AUTH_DB_PATH || path.join(process.cwd(), 'data', 'users.db')
  ).trim();
  if (!userAuthDbPath) {
    throw new Error('USER_AUTH_DB_PATH is empty');
  }

  ensureParentDir(userAuthDbPath);
  const db = new Database(userAuthDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  try {
    ensureUsersSchemaSqlite(db);

    const existing = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
    if (existing) {
      const nextPasswordHash = password ? hashPassword(password) : String(existing.password_hash || '');
      db.prepare(`
        UPDATE users
        SET
          password_hash = ?,
          first_name = COALESCE(?, first_name),
          last_name = COALESCE(?, last_name),
          can_edit = 1,
          is_admin = 1,
          is_master_admin = 1
        WHERE id = ?
      `).run(nextPasswordHash, firstName, lastName, existing.id);
      console.log(`[admin:create] user promoted to master admin: ${email}`);
      return;
    }

    if (!password) {
      throw new Error('--password is required when creating a new user');
    }

    db.prepare(`
      INSERT INTO users (email, password_hash, first_name, last_name, can_edit, is_admin, is_master_admin)
      VALUES (?, ?, ?, ?, 1, 1, 1)
    `).run(email, hashPassword(password), firstName, lastName);
    console.log(`[admin:create] master admin created: ${email}`);
  } finally {
    db.close();
  }
}

async function runPostgres({ email, password, firstName, lastName }: LooseRecord) {
  const connectionString = getPostgresConnectionString(process.env);
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for DB_PROVIDER=postgres');
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await ensureUsersSchemaPostgres(client);
    const existing = await client.query('SELECT id, password_hash FROM auth.users WHERE email = $1', [email]);
    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      const nextPasswordHash = password ? hashPassword(password) : String(row.password_hash || '');
      await client.query(`
        UPDATE auth.users
        SET
          password_hash = $1,
          first_name = COALESCE($2, first_name),
          last_name = COALESCE($3, last_name),
          can_edit = 1,
          is_admin = 1,
          is_master_admin = 1
        WHERE id = $4
      `, [nextPasswordHash, firstName, lastName, row.id]);
      console.log(`[admin:create] user promoted to master admin: ${email}`);
      return;
    }

    if (!password) {
      throw new Error('--password is required when creating a new user');
    }

    await client.query(`
      INSERT INTO auth.users (email, password_hash, first_name, last_name, can_edit, is_admin, is_master_admin)
      VALUES ($1, $2, $3, $4, 1, 1, 1)
    `, [email, hashPassword(password), firstName, lastName]);
    console.log(`[admin:create] master admin created: ${email}`);
  } finally {
    await client.end();
  }
}

async function run() {
  const args = parseArgs();
  const email = normalizeEmail(args.email);
  const password = String(args.password || '');
  const firstName = normalizeProfileName(args['first-name']);
  const lastName = normalizeProfileName(args['last-name']);

  if (!isValidEmail(email)) {
    console.error('[admin:create] --email is required and must be valid');
    printUsageAndExit();
  }

  if (password && password.length < 8) {
    throw new Error('--password must contain at least 8 characters');
  }

  const explicitDbProvider = String(process.env.DB_PROVIDER || '').trim().toLowerCase();
  const explicitUserAuthPath = String(process.env.USER_AUTH_DB_PATH || '').trim();
  const provider = explicitDbProvider || (explicitUserAuthPath ? 'sqlite' : getDbProvider(process.env));
  if (provider === 'postgres') {
    await runPostgres({ email, password, firstName, lastName });
    return;
  }
  runSqlite({ email, password, firstName, lastName });
}

run().catch((error) => {
  console.error('[admin:create] failed:', String(error?.message || error));
  process.exit(1);
});
