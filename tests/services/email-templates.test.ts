const test = require('node:test');
const assert = require('node:assert/strict');

const {
  passwordResetHtmlTemplate,
  passwordResetTextTemplate,
  registrationCodeHtmlTemplate,
  registrationCodeTextTemplate,
  smtpTestHtmlTemplate,
  smtpTestTextTemplate
} = require('../../src/lib/server/email-templates');

test('registration email matches the light site palette', () => {
  const html = registrationCodeHtmlTemplate({
    code: '583401',
    expiresInMinutes: 15,
    appDisplayName: 'ArchiMap',
    confirmUrl: 'https://example.com/account/?registerToken=sample'
  });

  assert.match(html, /background-color:#f6f4ef/);
  assert.match(html, /background:#fbfaf7/);
  assert.match(html, /color:#5b4300/);
  assert.match(html, /Регистрация/);
  assert.match(html, /Подтвердить регистрацию/);
  assert.match(html, /ArchiMap/);
  assert.match(html, /supported-color-schemes/);
});

test('password reset email matches the light site palette', () => {
  const html = passwordResetHtmlTemplate({
    resetUrl: 'https://example.com/?resetToken=sample',
    expiresInMinutes: 20,
    appDisplayName: 'ArchiMap'
  });

  assert.match(html, /background-color:#f6f4ef/);
  assert.match(html, /background:#fbfaf7/);
  assert.match(html, /color:#5b4300/);
  assert.match(html, /Восстановление/);
  assert.match(html, /Сбросить пароль/);
});

test('plain text email templates still include their links', () => {
  const registrationText = registrationCodeTextTemplate({
    code: '583401',
    expiresInMinutes: 15,
    appDisplayName: 'ArchiMap',
    confirmUrl: 'https://example.com/account/?registerToken=sample'
  });
  const passwordResetText = passwordResetTextTemplate({
    resetUrl: 'https://example.com/?resetToken=sample',
    expiresInMinutes: 20,
    appDisplayName: 'ArchiMap'
  });

  assert.match(registrationText, /https:\/\/example\.com\/account\/\?registerToken=sample/);
  assert.match(passwordResetText, /https:\/\/example\.com\/\?resetToken=sample/);
});

test('smtp test email matches the light site palette', () => {
  const html = smtpTestHtmlTemplate({
    smtp: {
      host: 'smtp-relay.example.com',
      port: 587,
      secure: false,
      from: 'ArchiMap <no-reply@example.com>'
    },
    testEmail: 'admin@example.test',
    sentAt: '2026-03-23T10:00:00.000Z',
    appDisplayName: 'ArchiMap'
  });

  assert.match(html, /background-color:#f6f4ef/);
  assert.match(html, /background:#fbfaf7/);
  assert.match(html, /Тест отправки почты/);
  assert.match(html, /Проверка/);
  assert.match(html, /smtp-relay\.example\.com/);
  assert.match(html, /587/);
  assert.match(html, /admin@example\.test/);
});

test('smtp test plain text template includes delivery details', () => {
  const text = smtpTestTextTemplate({
    smtp: {
      host: 'smtp-relay.example.com',
      port: 587,
      secure: false,
      from: 'ArchiMap <no-reply@example.com>'
    },
    testEmail: 'admin@example.test',
    sentAt: '2026-03-23T10:00:00.000Z',
    appDisplayName: 'ArchiMap'
  });

  assert.match(text, /ArchiMap: тест отправки почты/);
  assert.match(text, /admin@example\.test/);
  assert.match(text, /smtp-relay\.example\.com:587/);
});
