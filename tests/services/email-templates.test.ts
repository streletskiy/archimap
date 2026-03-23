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

test('registration email renders in both locales and keeps the light palette', () => {
  const enHtml = registrationCodeHtmlTemplate({
    code: '583401',
    expiresInMinutes: 15,
    appDisplayName: 'ArchiMap',
    confirmUrl: 'https://example.com/account/?registerToken=sample',
    locale: 'en'
  });
  const enText = registrationCodeTextTemplate({
    code: '583401',
    expiresInMinutes: 15,
    appDisplayName: 'ArchiMap',
    confirmUrl: 'https://example.com/account/?registerToken=sample',
    locale: 'en'
  });
  const ruHtml = registrationCodeHtmlTemplate({
    code: '583401',
    expiresInMinutes: 15,
    appDisplayName: 'ArchiMap',
    confirmUrl: 'https://example.com/account/?registerToken=sample',
    locale: 'ru'
  });
  const ruText = registrationCodeTextTemplate({
    code: '583401',
    expiresInMinutes: 15,
    appDisplayName: 'ArchiMap',
    confirmUrl: 'https://example.com/account/?registerToken=sample',
    locale: 'ru'
  });

  assert.match(enHtml, /background-color:#f6f4ef/);
  assert.match(enHtml, /background:#fbfaf7/);
  assert.match(enHtml, /Confirm registration/);
  assert.match(enHtml, /<html lang="en">/);
  assert.match(enHtml, /lang=en/);
  assert.match(enHtml, /supported-color-schemes/);
  assert.match(enText, /Your code: 583401/);
  assert.ok(enText.includes('Confirmation link: https://example.com/account/?registerToken=sample&lang=en'));

  assert.match(ruHtml, /background-color:#f6f4ef/);
  assert.match(ruHtml, /background:#fbfaf7/);
  assert.match(ruHtml, /Подтвердить регистрацию/);
  assert.match(ruHtml, /<html lang="ru">/);
  assert.match(ruHtml, /lang=ru/);
  assert.match(ruText, /Ваш код: 583401/);
  assert.ok(ruText.includes('Подтверждение по ссылке: https://example.com/account/?registerToken=sample&lang=ru'));
});

test('password reset email renders in both locales and keeps the light palette', () => {
  const enHtml = passwordResetHtmlTemplate({
    resetUrl: 'https://example.com/?resetToken=sample',
    expiresInMinutes: 20,
    appDisplayName: 'ArchiMap',
    locale: 'en'
  });
  const enText = passwordResetTextTemplate({
    resetUrl: 'https://example.com/?resetToken=sample',
    expiresInMinutes: 20,
    appDisplayName: 'ArchiMap',
    locale: 'en'
  });
  const ruHtml = passwordResetHtmlTemplate({
    resetUrl: 'https://example.com/?resetToken=sample',
    expiresInMinutes: 20,
    appDisplayName: 'ArchiMap',
    locale: 'ru'
  });
  const ruText = passwordResetTextTemplate({
    resetUrl: 'https://example.com/?resetToken=sample',
    expiresInMinutes: 20,
    appDisplayName: 'ArchiMap',
    locale: 'ru'
  });

  assert.match(enHtml, /background-color:#f6f4ef/);
  assert.match(enHtml, /Reset password/);
  assert.match(enHtml, /<html lang="en">/);
  assert.match(enHtml, /lang=en/);
  assert.ok(enText.includes('Reset link: https://example.com/?resetToken=sample&lang=en'));

  assert.match(ruHtml, /background:#fbfaf7/);
  assert.match(ruHtml, /Сброс пароля/);
  assert.match(ruHtml, /<html lang="ru">/);
  assert.match(ruHtml, /lang=ru/);
  assert.ok(ruText.includes('Ссылка для сброса: https://example.com/?resetToken=sample&lang=ru'));
});

test('smtp test email renders in both locales and includes delivery details', () => {
  const enHtml = smtpTestHtmlTemplate({
    smtp: {
      host: 'smtp-relay.example.com',
      port: 587,
      secure: false,
      from: 'ArchiMap <no-reply@example.com>'
    },
    testEmail: 'admin@example.test',
    sentAt: '2026-03-23T10:00:00.000Z',
    appDisplayName: 'ArchiMap',
    locale: 'en'
  });
  const enText = smtpTestTextTemplate({
    smtp: {
      host: 'smtp-relay.example.com',
      port: 587,
      secure: false,
      from: 'ArchiMap <no-reply@example.com>'
    },
    testEmail: 'admin@example.test',
    sentAt: '2026-03-23T10:00:00.000Z',
    appDisplayName: 'ArchiMap',
    locale: 'en'
  });
  const ruHtml = smtpTestHtmlTemplate({
    smtp: {
      host: 'smtp-relay.example.com',
      port: 587,
      secure: false,
      from: 'ArchiMap <no-reply@example.com>'
    },
    testEmail: 'admin@example.test',
    sentAt: '2026-03-23T10:00:00.000Z',
    appDisplayName: 'ArchiMap',
    locale: 'ru'
  });
  const ruText = smtpTestTextTemplate({
    smtp: {
      host: 'smtp-relay.example.com',
      port: 587,
      secure: false,
      from: 'ArchiMap <no-reply@example.com>'
    },
    testEmail: 'admin@example.test',
    sentAt: '2026-03-23T10:00:00.000Z',
    appDisplayName: 'ArchiMap',
    locale: 'ru'
  });

  assert.match(enHtml, /background-color:#f6f4ef/);
  assert.match(enHtml, /Mail delivery test/);
  assert.match(enHtml, /<html lang="en">/);
  assert.match(enHtml, /admin@example\.test/);
  assert.ok(enHtml.includes('smtp-relay.example.com'));
  assert.match(enText, /ArchiMap: mail delivery test/);
  assert.match(enText, /Date: /);
  assert.match(enText, /Secure: No/);

  assert.match(ruHtml, /background:#fbfaf7/);
  assert.match(ruHtml, /Тест отправки почты/);
  assert.match(ruHtml, /<html lang="ru">/);
  assert.match(ruHtml, /Проверка/);
  assert.match(ruHtml, /admin@example\.test/);
  assert.ok(ruHtml.includes('smtp-relay.example.com'));
  assert.match(ruText, /ArchiMap: тест отправки почты/);
  assert.match(ruText, /Дата: /);
  assert.match(ruText, /Безопасное соединение: Нет/);
});
