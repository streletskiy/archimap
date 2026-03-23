const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const authServicePath = require.resolve('../../src/lib/server/auth/auth.service');
const authIndexPath = require.resolve('../../src/lib/server/auth');
const smtpTransportServicePath = require.resolve('../../src/lib/server/services/smtp-transport.service');

function createAuthDb() {
  const db = new Database(':memory:');
  db.exec("ATTACH DATABASE ':memory:' AS auth");
  const { ensureAuthSchema } = require('../../src/lib/server/auth');
  ensureAuthSchema(db);
  return db;
}

test('registration email uses the locale from the request cookie', async (t) => {
  const originalAuthServiceCache = require.cache[authServicePath];
  const originalAuthIndexCache = require.cache[authIndexPath];
  const originalSmtpTransportCache = require.cache[smtpTransportServicePath];
  let capturedMailOptions = null;

  require.cache[smtpTransportServicePath] = {
    id: smtpTransportServicePath,
    filename: smtpTransportServicePath,
    loaded: true,
    exports: {
      sendMailWithFallback: async (_smtp, mailOptions) => {
        capturedMailOptions = mailOptions;
        return {
          info: {
            accepted: ['user@example.test'],
            rejected: [],
            pending: [],
            messageId: 'test-message-id'
          },
          candidate: { label: 'stub' }
        };
      }
    }
  };

  delete require.cache[authIndexPath];
  delete require.cache[authServicePath];
  t.after(() => {
    if (originalAuthServiceCache) {
      require.cache[authServicePath] = originalAuthServiceCache;
    } else {
      delete require.cache[authServicePath];
    }

    if (originalAuthIndexCache) {
      require.cache[authIndexPath] = originalAuthIndexCache;
    } else {
      delete require.cache[authIndexPath];
    }

    if (originalSmtpTransportCache) {
      require.cache[smtpTransportServicePath] = originalSmtpTransportCache;
    } else {
      delete require.cache[smtpTransportServicePath];
    }
  });

  const { createAuthService } = require(authServicePath);
  const db = createAuthDb();
  t.after(() => db.close());
  const service = createAuthService({
    db,
    sessionSecret: 'test-secret',
    registrationEnabled: true,
    registrationCodeTtlMinutes: 15,
    registrationCodeResendCooldownSec: 60,
    registrationCodeMaxAttempts: 5,
    registrationMinPasswordLength: 8,
    passwordResetTtlMinutes: 20,
    appBaseUrl: 'https://example.com',
    appDisplayName: 'ArchiMap',
    smtp: {
      host: 'smtp-relay.example.com',
      port: 587,
      secure: false,
      user: 'smtp-user',
      pass: 'smtp-pass',
      from: 'ArchiMap <no-reply@example.com>'
    }
  });

  const result = await service.startRegistration({
    body: {
      email: 'user@example.test',
      password: '12345678',
      firstName: 'Test',
      lastName: 'User',
      acceptTerms: true,
      acceptPrivacy: true
    },
    headers: {
      cookie: 'archimap_locale=ru'
    }
  });

  assert.equal(result.payload.ok, true);
  assert.ok(capturedMailOptions);
  assert.match(capturedMailOptions.subject, /код подтверждения регистрации/);
  assert.match(capturedMailOptions.html, /<html lang="ru">/);
  assert.match(capturedMailOptions.html, /Подтвердить регистрацию/);
  assert.match(capturedMailOptions.text, /Ваш код:/);
  assert.match(capturedMailOptions.text, /lang=ru/);
});

test('password reset email uses the locale from the request cookie', async (t) => {
  const originalAuthServiceCache = require.cache[authServicePath];
  const originalAuthIndexCache = require.cache[authIndexPath];
  const originalSmtpTransportCache = require.cache[smtpTransportServicePath];
  let capturedMailOptions = null;

  require.cache[smtpTransportServicePath] = {
    id: smtpTransportServicePath,
    filename: smtpTransportServicePath,
    loaded: true,
    exports: {
      sendMailWithFallback: async (_smtp, mailOptions) => {
        capturedMailOptions = mailOptions;
        return {
          info: {
            accepted: ['reset@example.test'],
            rejected: [],
            pending: [],
            messageId: 'test-message-id'
          },
          candidate: { label: 'stub' }
        };
      }
    }
  };

  delete require.cache[authIndexPath];
  delete require.cache[authServicePath];
  t.after(() => {
    if (originalAuthServiceCache) {
      require.cache[authServicePath] = originalAuthServiceCache;
    } else {
      delete require.cache[authServicePath];
    }

    if (originalAuthIndexCache) {
      require.cache[authIndexPath] = originalAuthIndexCache;
    } else {
      delete require.cache[authIndexPath];
    }

    if (originalSmtpTransportCache) {
      require.cache[smtpTransportServicePath] = originalSmtpTransportCache;
    } else {
      delete require.cache[smtpTransportServicePath];
    }
  });

  const { createAuthService } = require(authServicePath);
  const db = createAuthDb();
  t.after(() => db.close());
  db.prepare(`
    INSERT INTO auth.users (
      email,
      password_hash,
      first_name,
      last_name,
      can_edit,
      is_admin,
      is_master_admin
    )
    VALUES (?, ?, ?, ?, 0, 0, 0)
  `).run('reset@example.test', 'scrypt$salt$hash', 'Reset', 'User');

  const service = createAuthService({
    db,
    sessionSecret: 'test-secret',
    registrationEnabled: true,
    registrationCodeTtlMinutes: 15,
    registrationCodeResendCooldownSec: 60,
    registrationCodeMaxAttempts: 5,
    registrationMinPasswordLength: 8,
    passwordResetTtlMinutes: 20,
    appBaseUrl: 'https://example.com',
    appDisplayName: 'ArchiMap',
    smtp: {
      host: 'smtp-relay.example.com',
      port: 587,
      secure: false,
      user: 'smtp-user',
      pass: 'smtp-pass',
      from: 'ArchiMap <no-reply@example.com>'
    }
  });

  const result = await service.requestPasswordReset({
    body: {
      email: 'reset@example.test'
    },
    headers: {
      cookie: 'archimap_locale=en'
    }
  });

  assert.equal(result.payload.ok, true);
  assert.ok(capturedMailOptions);
  assert.match(capturedMailOptions.subject, /password reset/);
  assert.match(capturedMailOptions.html, /<html lang="en">/);
  assert.match(capturedMailOptions.html, /Reset password/);
  assert.match(capturedMailOptions.text, /Reset link:/);
  assert.match(capturedMailOptions.text, /lang=en/);
});
