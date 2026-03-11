function ensureAuthSchema(db) {
  if (db?.provider === 'postgres') {
    return;
  }

  db.exec(`
CREATE TABLE IF NOT EXISTS auth.users (
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

CREATE TABLE IF NOT EXISTS auth.email_registration_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  password_hash TEXT,
  first_name TEXT,
  last_name TEXT,
  verify_token_hash TEXT
);

CREATE INDEX IF NOT EXISTS auth.idx_email_registration_codes_expires
ON email_registration_codes (expires_at);

CREATE INDEX IF NOT EXISTS auth.idx_email_registration_codes_verify_token
ON email_registration_codes (verify_token_hash);

CREATE TABLE IF NOT EXISTS auth.password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS auth.idx_password_reset_tokens_email
ON password_reset_tokens (email);

CREATE INDEX IF NOT EXISTS auth.idx_password_reset_tokens_expires
ON password_reset_tokens (expires_at);
`);

  const userColumns = db.prepare('PRAGMA auth.table_info(users)').all();
  const hasMasterAdminColumn = userColumns.some((column) => String(column?.name || '').trim() === 'is_master_admin');
  if (!hasMasterAdminColumn) {
    db.exec('ALTER TABLE auth.users ADD COLUMN is_master_admin INTEGER NOT NULL DEFAULT 0;');
  }
}

module.exports = {
  ensureAuthSchema
};
