const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const authServicePath = require.resolve('../../src/lib/server/auth/auth.service');
const authIndexPath = require.resolve('../../src/lib/server/auth');
const smtpTransportServicePath = require.resolve('../../src/lib/server/services/smtp-transport.service');

function createAuthDb() {
  const db = new Database(':memory:');
  db.exec("ATTACH DATABASE ':memory:' AS auth");
  db.transaction = (fn) => async (...args) => {
    db.exec('BEGIN');
    try {
      const result = await fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore rollback cleanup errors to keep the original failure
      }
      throw error;
    }
  };
  const { ensureAuthSchema } = require('../../src/lib/server/auth');
  ensureAuthSchema(db);
  return db;
}

test('password reset token can be confirmed once and updates the password', async (t) => {
  const originalAuthServiceCache = require.cache[authServicePath];
  const originalAuthIndexCache = require.cache[authIndexPath];
  const originalSmtpTransportCache = require.cache[smtpTransportServicePath];
  let capturedMailOptions = null;

  const smtpTransportMock = {
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
  } as unknown as NodeJS.Module;
  require.cache[smtpTransportServicePath] = smtpTransportMock;

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

  const requestResult = await service.requestPasswordReset({
    body: {
      email: 'reset@example.test',
      locale: 'en'
    }
  });

  assert.equal(requestResult.payload.ok, true);
  assert.ok(capturedMailOptions);
  const resetTokenMatch = capturedMailOptions.text.match(/resetToken=([a-f0-9]+)&lang=en/);
  assert.ok(resetTokenMatch, 'expected a reset token in the outgoing email');
  const resetToken = resetTokenMatch[1];
  assert.equal(resetToken.length, 64);

  const confirmResult = await service.confirmPasswordReset({
    body: {
      token: resetToken,
      newPassword: 'new-password-123'
    }
  });

  assert.equal(confirmResult.payload.ok, true);

  const resetRows = db.prepare('SELECT used_at FROM auth.password_reset_tokens WHERE email = ?').all('reset@example.test');
  assert.equal(resetRows.length, 1);
  assert.ok(Number(resetRows[0].used_at || 0) > 0);

  const session = {
    user: null,
    regenerate(callback) {
      callback();
    },
    save(callback) {
      callback();
    }
  };

  const loginResult = await service.login({
    body: {
      email: 'reset@example.test',
      password: 'new-password-123'
    },
    session
  });

  assert.equal(loginResult.payload.ok, true);
  assert.equal(session.user.email, 'reset@example.test');

  const reusedResult = await service.confirmPasswordReset({
    body: {
      token: resetToken,
      newPassword: 'another-new-password'
    }
  });

  assert.equal(reusedResult.status, 400);
  assert.equal(reusedResult.code, 'ERR_PASSWORD_RESET_LINK_INVALID');
});
