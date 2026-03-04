require('dotenv').config({ quiet: true });

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

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
  process.exit(0);
}

db.prepare(`
  INSERT INTO users (email, password_hash, first_name, last_name, can_edit, is_admin, is_master_admin)
  VALUES (?, ?, ?, ?, 1, 1, 1)
`).run(seedEmail, hashPassword('DemoAdmin12345'), 'Demo', 'Admin');

console.log(`Seed user created: ${seedEmail} / DemoAdmin12345`);
