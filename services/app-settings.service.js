const crypto = require('crypto');

function createAppSettingsService(options = {}) {
  const {
    db,
    settingsSecret,
    fallbackSmtp = {},
    fallbackGeneral = {}
  } = options;

  if (!db) {
    throw new Error('createAppSettingsService: db is required');
  }

  const secret = String(settingsSecret || '').trim();
  if (!secret) {
    throw new Error('createAppSettingsService: settingsSecret is required');
  }

  const secretKey = crypto.createHash('sha256').update(secret).digest();

  function normalizeBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    const text = String(value ?? '').trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'yes') return true;
    if (text === 'false' || text === '0' || text === 'no') return false;
    return Boolean(fallback);
  }

  function normalizeSmtpShape(raw = {}) {
    const url = String(raw.url || '').trim();
    const host = String(raw.host || '').trim();
    const portNum = Number(raw.port);
    const port = Number.isInteger(portNum) && portNum > 0 && portNum <= 65535 ? portNum : 587;
    const secure = normalizeBoolean(raw.secure, false);
    const user = String(raw.user || '').trim();
    const from = String(raw.from || user || '').trim();
    const pass = String(raw.pass || '').trim();
    return { url, host, port, secure, user, pass, from };
  }

  function normalizeGeneralShape(raw = {}) {
    const appDisplayName = String(raw.appDisplayName || raw.app_display_name || 'Archimap').trim() || 'Archimap';
    const appBaseUrl = String(raw.appBaseUrl || raw.app_base_url || '').trim();
    const registrationEnabled = normalizeBoolean(raw.registrationEnabled ?? raw.registration_enabled, true);
    const userEditRequiresPermission = normalizeBoolean(raw.userEditRequiresPermission ?? raw.user_edit_requires_permission, true);
    return {
      appDisplayName,
      appBaseUrl,
      registrationEnabled,
      userEditRequiresPermission
    };
  }

  function encryptSecret(plaintext) {
    const value = String(plaintext || '');
    if (!value) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
  }

  function decryptSecret(encoded) {
    const value = String(encoded || '').trim();
    if (!value) return '';
    const parts = value.split('.');
    if (parts.length !== 3) return '';
    try {
      const iv = Buffer.from(parts[0], 'base64');
      const tag = Buffer.from(parts[1], 'base64');
      const encrypted = Buffer.from(parts[2], 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  function readStoredSmtpRow() {
    try {
      return db.prepare(`
        SELECT
          smtp_url,
          smtp_host,
          smtp_port,
          smtp_secure,
          smtp_user,
          smtp_pass_enc,
          email_from,
          updated_by,
          updated_at
        FROM app_smtp_settings
        WHERE id = 1
        LIMIT 1
      `).get() || null;
    } catch {
      return null;
    }
  }

  function readStoredGeneralRow() {
    try {
      return db.prepare(`
        SELECT
          app_display_name,
          app_base_url,
          registration_enabled,
          user_edit_requires_permission,
          updated_by,
          updated_at
        FROM app_general_settings
        WHERE id = 1
        LIMIT 1
      `).get() || null;
    } catch {
      return null;
    }
  }

  function toEffectiveSmtpConfig(row) {
    const fallback = normalizeSmtpShape(fallbackSmtp);
    const hasDbRecord = Boolean(row);
    const dbConfig = row
      ? normalizeSmtpShape({
        url: row.smtp_url,
        host: row.smtp_host,
        port: row.smtp_port,
        secure: Number(row.smtp_secure || 0) > 0,
        user: row.smtp_user,
        from: row.email_from,
        pass: decryptSecret(row.smtp_pass_enc)
      })
      : null;

    const hasDbValues = Boolean(
      dbConfig
      && (dbConfig.url || dbConfig.host || dbConfig.user || dbConfig.from || dbConfig.pass)
    );

    const chosen = hasDbValues ? dbConfig : fallback;
    return {
      source: hasDbValues ? 'db' : 'env',
      hasDbRecord,
      config: chosen,
      hasPassword: Boolean(chosen.pass),
      updatedBy: row?.updated_by ? String(row.updated_by) : null,
      updatedAt: row?.updated_at ? String(row.updated_at) : null
    };
  }

  function getEffectiveSmtpConfig() {
    const row = readStoredSmtpRow();
    return toEffectiveSmtpConfig(row);
  }

  function toEffectiveGeneralConfig(row) {
    const fallback = normalizeGeneralShape(fallbackGeneral);
    const hasDbRecord = Boolean(row);
    const dbConfig = row
      ? normalizeGeneralShape({
        app_display_name: row.app_display_name,
        app_base_url: row.app_base_url,
        registration_enabled: Number(row.registration_enabled || 0) > 0,
        user_edit_requires_permission: Number(row.user_edit_requires_permission || 0) > 0
      })
      : null;

    const hasDbValues = Boolean(
      dbConfig
      && (dbConfig.appDisplayName
        || dbConfig.appBaseUrl
        || Object.prototype.hasOwnProperty.call(row || {}, 'registration_enabled')
        || Object.prototype.hasOwnProperty.call(row || {}, 'user_edit_requires_permission'))
    );

    const chosen = hasDbValues ? dbConfig : fallback;
    return {
      source: hasDbValues ? 'db' : 'env',
      hasDbRecord,
      config: chosen,
      updatedBy: row?.updated_by ? String(row.updated_by) : null,
      updatedAt: row?.updated_at ? String(row.updated_at) : null
    };
  }

  function getEffectiveGeneralConfig() {
    const row = readStoredGeneralRow();
    return toEffectiveGeneralConfig(row);
  }

  function getSmtpSettingsForAdmin() {
    const effective = getEffectiveSmtpConfig();
    return {
      source: effective.source,
      smtp: {
        url: effective.config.url,
        host: effective.config.host,
        port: effective.config.port,
        secure: effective.config.secure,
        user: effective.config.user,
        from: effective.config.from,
        hasPassword: effective.hasPassword
      },
      updatedBy: effective.updatedBy,
      updatedAt: effective.updatedAt
    };
  }

  function getGeneralSettingsForAdmin() {
    const effective = getEffectiveGeneralConfig();
    return {
      source: effective.source,
      general: {
        appDisplayName: effective.config.appDisplayName,
        appBaseUrl: effective.config.appBaseUrl,
        registrationEnabled: effective.config.registrationEnabled,
        userEditRequiresPermission: effective.config.userEditRequiresPermission
      },
      updatedBy: effective.updatedBy,
      updatedAt: effective.updatedAt
    };
  }

  function buildSmtpConfigFromInput(input = {}, options = {}) {
    const existing = getEffectiveSmtpConfig().config;
    const keepPassword = options.keepPassword !== false;
    const normalized = normalizeSmtpShape({
      url: input.url,
      host: input.host,
      port: input.port,
      secure: input.secure,
      user: input.user,
      from: input.from
    });

    const hasPasswordField = Object.prototype.hasOwnProperty.call(input, 'pass');
    const passRaw = hasPasswordField ? String(input.pass || '') : '';
    const pass = hasPasswordField
      ? passRaw.trim()
      : (keepPassword ? String(existing.pass || '') : '');

    return {
      ...normalized,
      pass
    };
  }

  function saveSmtpSettings(input = {}, actor = null) {
    const next = buildSmtpConfigFromInput(input, {
      keepPassword: Boolean(input.keepPassword !== false)
    });
    const encryptedPass = next.pass ? encryptSecret(next.pass) : '';
    const updatedBy = actor == null ? null : String(actor).trim().toLowerCase() || null;

    db.prepare(`
      INSERT INTO app_smtp_settings (
        id,
        smtp_url,
        smtp_host,
        smtp_port,
        smtp_secure,
        smtp_user,
        smtp_pass_enc,
        email_from,
        updated_by,
        updated_at
      )
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        smtp_url = excluded.smtp_url,
        smtp_host = excluded.smtp_host,
        smtp_port = excluded.smtp_port,
        smtp_secure = excluded.smtp_secure,
        smtp_user = excluded.smtp_user,
        smtp_pass_enc = excluded.smtp_pass_enc,
        email_from = excluded.email_from,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(
      next.url || null,
      next.host || null,
      next.port,
      next.secure ? 1 : 0,
      next.user || null,
      encryptedPass || null,
      next.from || null,
      updatedBy
    );

    return getSmtpSettingsForAdmin();
  }

  function saveGeneralSettings(input = {}, actor = null) {
    const next = normalizeGeneralShape(input);
    const updatedBy = actor == null ? null : String(actor).trim().toLowerCase() || null;

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
      ON CONFLICT(id) DO UPDATE SET
        app_display_name = excluded.app_display_name,
        app_base_url = excluded.app_base_url,
        registration_enabled = excluded.registration_enabled,
        user_edit_requires_permission = excluded.user_edit_requires_permission,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(
      next.appDisplayName,
      next.appBaseUrl || null,
      next.registrationEnabled ? 1 : 0,
      next.userEditRequiresPermission ? 1 : 0,
      updatedBy
    );

    return getGeneralSettingsForAdmin();
  }

  return {
    normalizeSmtpShape,
    normalizeGeneralShape,
    getEffectiveSmtpConfig,
    getEffectiveGeneralConfig,
    getSmtpSettingsForAdmin,
    getGeneralSettingsForAdmin,
    buildSmtpConfigFromInput,
    saveSmtpSettings,
    saveGeneralSettings
  };
}

module.exports = {
  createAppSettingsService
};
