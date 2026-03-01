const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createAppSettingsService } = require('../../services/app-settings.service');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_smtp_settings (
      id INTEGER PRIMARY KEY,
      smtp_url TEXT,
      smtp_host TEXT,
      smtp_port INTEGER,
      smtp_secure INTEGER,
      smtp_user TEXT,
      smtp_pass_enc TEXT,
      email_from TEXT,
      updated_by TEXT,
      updated_at TEXT
    );

    CREATE TABLE app_general_settings (
      id INTEGER PRIMARY KEY,
      app_display_name TEXT,
      app_base_url TEXT,
      registration_enabled INTEGER,
      user_edit_requires_permission INTEGER,
      updated_by TEXT,
      updated_at TEXT
    );
  `);
  return db;
}

test('buildSmtpConfigFromInput keeps existing password when pass is empty and keepPassword=true', () => {
  const db = createTestDb();
  const service = createAppSettingsService({
    db,
    settingsSecret: 'test-secret',
    fallbackSmtp: {}
  });

  service.saveSmtpSettings({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    user: 'smtp-user',
    pass: 'saved-pass',
    from: 'archimap <no-reply@example.com>',
    keepPassword: true
  }, 'admin@example.com');

  const candidate = service.buildSmtpConfigFromInput({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    user: 'smtp-user',
    pass: '',
    from: 'archimap <no-reply@example.com>'
  }, { keepPassword: true });

  assert.equal(candidate.pass, 'saved-pass');
});

test('buildSmtpConfigFromInput clears password when pass is empty and keepPassword=false', () => {
  const db = createTestDb();
  const service = createAppSettingsService({
    db,
    settingsSecret: 'test-secret',
    fallbackSmtp: {}
  });

  service.saveSmtpSettings({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    user: 'smtp-user',
    pass: 'saved-pass',
    from: 'archimap <no-reply@example.com>',
    keepPassword: true
  }, 'admin@example.com');

  const candidate = service.buildSmtpConfigFromInput({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    user: 'smtp-user',
    pass: '',
    from: 'archimap <no-reply@example.com>'
  }, { keepPassword: false });

  assert.equal(candidate.pass, '');
});
