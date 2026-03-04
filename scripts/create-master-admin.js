require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

function parseArgs(argv = process.argv.slice(2)) {
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

function ensureUsersSchema(db) {
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

function printUsageAndExit() {
  console.log('Usage: node scripts/create-master-admin.js --email=<email> [--password=<password>] [--first-name=<name>] [--last-name=<name>]');
  console.log('Behavior: creates a new master admin, or promotes existing user to master admin.');
  process.exit(1);
}

function run() {
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
    console.error('[admin:create] --password must contain at least 8 characters');
    process.exit(1);
  }

  const userAuthDbPath = String(
    process.env.USER_AUTH_DB_PATH || path.join(process.cwd(), 'data', 'users.db')
  ).trim();
  if (!userAuthDbPath) {
    console.error('[admin:create] USER_AUTH_DB_PATH is empty');
    process.exit(1);
  }

  ensureParentDir(userAuthDbPath);
  const db = new Database(userAuthDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  try {
    ensureUsersSchema(db);

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
      console.error('[admin:create] --password is required when creating a new user');
      process.exit(1);
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

try {
  run();
} catch (error) {
  console.error('[admin:create] failed:', String(error?.message || error));
  process.exit(1);
}
