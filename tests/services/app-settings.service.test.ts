const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createAppSettingsService } = require('../../src/lib/server/services/app-settings.service');

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

function enableBasemapColumns(db) {
  db.exec(`
    ALTER TABLE app_general_settings ADD COLUMN basemap_provider TEXT NOT NULL DEFAULT 'carto';
    ALTER TABLE app_general_settings ADD COLUMN maptiler_api_key TEXT;
  `);
}

test('buildSmtpConfigFromInput keeps existing password when pass is empty and keepPassword=true', async () => {
  const db = createTestDb();
  const service = createAppSettingsService({
    db,
    settingsSecret: 'test-secret',
    fallbackSmtp: {}
  });

  await service.saveSmtpSettings({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    user: 'smtp-user',
    pass: 'saved-pass',
    from: 'archimap <no-reply@example.com>',
    keepPassword: true
  }, 'admin@example.com');

  const candidate = await service.buildSmtpConfigFromInput({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    user: 'smtp-user',
    pass: '',
    from: 'archimap <no-reply@example.com>'
  }, { keepPassword: true });

  assert.equal(candidate.pass, 'saved-pass');
});

test('buildSmtpConfigFromInput clears password when pass is empty and keepPassword=false', async () => {
  const db = createTestDb();
  const service = createAppSettingsService({
    db,
    settingsSecret: 'test-secret',
    fallbackSmtp: {}
  });

  await service.saveSmtpSettings({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    user: 'smtp-user',
    pass: 'saved-pass',
    from: 'archimap <no-reply@example.com>',
    keepPassword: true
  }, 'admin@example.com');

  const candidate = await service.buildSmtpConfigFromInput({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    user: 'smtp-user',
    pass: '',
    from: 'archimap <no-reply@example.com>'
  }, { keepPassword: false });

  assert.equal(candidate.pass, '');
});

test('getGeneralSettingsForAdmin reads legacy schema without metrics_token', async () => {
  const db = createTestDb();
  const service = createAppSettingsService({
    db,
    settingsSecret: 'test-secret',
    fallbackGeneral: {}
  });

  db.prepare(`
    INSERT INTO app_general_settings (
      id,
      app_display_name,
      app_base_url,
      registration_enabled,
      user_edit_requires_permission,
      updated_by,
      updated_at
    )
    VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
  `).run('legacy-archimap', 'https://example.com', 1, 0, 'admin@example.com');

  const settings = await service.getGeneralSettingsForAdmin();

  assert.equal(settings.general.appDisplayName, 'legacy-archimap');
  assert.equal(settings.general.appBaseUrl, 'https://example.com');
  assert.equal(settings.general.registrationEnabled, true);
  assert.equal(settings.general.userEditRequiresPermission, false);
  assert.equal(settings.general.metricsToken, '');
});

test('saveGeneralSettings updates legacy schema without metrics_token', async () => {
  const db = createTestDb();
  const service = createAppSettingsService({
    db,
    settingsSecret: 'test-secret',
    fallbackGeneral: {}
  });

  const settings = await service.saveGeneralSettings({
    appDisplayName: 'legacy-save',
    appBaseUrl: 'https://legacy.example.com',
    registrationEnabled: false,
    userEditRequiresPermission: true
  }, 'admin@example.com');

  const row = db.prepare(`
    SELECT
      app_display_name,
      app_base_url,
      registration_enabled,
      user_edit_requires_permission,
      updated_by
    FROM app_general_settings
    WHERE id = 1
  `).get();

  assert.equal(row.app_display_name, 'legacy-save');
  assert.equal(row.app_base_url, 'https://legacy.example.com');
  assert.equal(row.registration_enabled, 0);
  assert.equal(row.user_edit_requires_permission, 1);
  assert.equal(row.updated_by, 'admin@example.com');
  assert.equal(settings.general.metricsToken, '');
});

test('saveGeneralSettings persists basemap provider and maptiler api key when schema supports it', async () => {
  const db = createTestDb();
  enableBasemapColumns(db);
  db.exec('ALTER TABLE app_general_settings ADD COLUMN metrics_token TEXT;');
  const service = createAppSettingsService({
    db,
    settingsSecret: 'test-secret',
    fallbackGeneral: {}
  });

  const settings = await service.saveGeneralSettings({
    appDisplayName: 'basemap-test',
    appBaseUrl: 'https://example.com',
    registrationEnabled: true,
    userEditRequiresPermission: false,
    basemapProvider: 'maptiler',
    maptilerApiKey: 'test-maptiler-key'
  }, 'admin@example.com');

  const row = db.prepare(`
    SELECT
      basemap_provider,
      maptiler_api_key
    FROM app_general_settings
    WHERE id = 1
  `).get();

  assert.equal(row.basemap_provider, 'maptiler');
  assert.equal(row.maptiler_api_key, 'test-maptiler-key');
  assert.equal(settings.general.basemapProvider, 'maptiler');
  assert.equal(settings.general.maptilerApiKey, 'test-maptiler-key');
});

test('saveGeneralSettings rejects maptiler provider without api key', async () => {
  const db = createTestDb();
  enableBasemapColumns(db);
  const service = createAppSettingsService({
    db,
    settingsSecret: 'test-secret',
    fallbackGeneral: {}
  });

  await assert.rejects(
    () => service.saveGeneralSettings({
      appDisplayName: 'invalid-maptiler',
      basemapProvider: 'maptiler',
      maptilerApiKey: ''
    }, 'admin@example.com'),
    (error) => {
      assert.equal(error?.status, 400);
      assert.match(String(error?.message || ''), /MapTiler API key/i);
      return true;
    }
  );
});
