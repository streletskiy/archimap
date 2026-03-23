const test = require('node:test');
const assert = require('node:assert/strict');

const adminSettingsServicePath = require.resolve('../../src/lib/server/services/admin/admin-settings.service');
const smtpTransportServicePath = require.resolve('../../src/lib/server/services/smtp-transport.service');

test('buildEmailPreviewPayload includes the SMTP test template in the requested locale', async () => {
  const { createAdminSettingsService } = require(adminSettingsServicePath);
  const service = createAdminSettingsService({
    appDisplayName: 'ArchiMap',
    appBaseUrl: 'https://example.com',
    registrationCodeTtlMinutes: 15,
    passwordResetTtlMinutes: 20
  });

  const payload = await service.buildEmailPreviewPayload({ locale: 'ru' });

  assert.equal(payload.appDisplayName, 'ArchiMap');
  assert.ok(payload.templates.smtpTest);
  assert.match(payload.templates.registration.html, /<html lang="ru">/);
  assert.match(payload.templates.registration.text, /Ваш код:/);
  assert.match(payload.templates.registration.text, /lang=ru/);
  assert.match(payload.templates.smtpTest.html, /Тест отправки почты/);
  assert.ok(payload.templates.smtpTest.html.includes('smtp-relay.example.com'));
  assert.match(payload.templates.smtpTest.html, /admin@example\.test/);
  assert.match(payload.templates.smtpTest.text, /ArchiMap: тест отправки почты/);
});

test('sendSmtpTest sends html and text content', async (t) => {
  const originalAdminSettingsCache = require.cache[adminSettingsServicePath];
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
            accepted: ['admin@example.test'],
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

  delete require.cache[adminSettingsServicePath];
  t.after(() => {
    if (originalAdminSettingsCache) {
      require.cache[adminSettingsServicePath] = originalAdminSettingsCache;
    } else {
      delete require.cache[adminSettingsServicePath];
    }

    if (originalSmtpTransportCache) {
      require.cache[smtpTransportServicePath] = originalSmtpTransportCache;
    } else {
      delete require.cache[smtpTransportServicePath];
    }
  });

  const { createAdminSettingsService } = require(adminSettingsServicePath);
  const service = createAdminSettingsService({
    appDisplayName: 'ArchiMap',
    appSettingsService: {
      async buildSmtpConfigFromInput() {
        return {
          host: 'smtp-relay.example.com',
          port: 587,
          secure: false,
          user: 'smtp-user',
          pass: 'smtp-pass',
          from: 'ArchiMap <no-reply@example.com>'
        };
      }
    }
  });

  const result = await service.sendSmtpTest({
    smtp: {
      host: 'smtp-relay.example.com',
      port: 587,
      secure: false,
      user: 'smtp-user',
      pass: 'smtp-pass',
      from: 'ArchiMap <no-reply@example.com>'
    },
    testEmail: 'admin@example.test',
    locale: 'en'
  });

  assert.equal(result.ok, true);
  assert.ok(capturedMailOptions);
  assert.equal(capturedMailOptions.to, 'admin@example.test');
  assert.match(capturedMailOptions.subject, /SMTP test|mail delivery test/);
  assert.match(capturedMailOptions.html, /Mail delivery test/);
  assert.match(capturedMailOptions.html, /<html lang="en">/);
  assert.match(capturedMailOptions.html, /background-color:#f6f4ef/);
  assert.match(capturedMailOptions.text, /ArchiMap: mail delivery test/);
  assert.ok(capturedMailOptions.text.includes('smtp-relay.example.com:587'));
});
