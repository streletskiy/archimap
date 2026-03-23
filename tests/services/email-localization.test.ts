const test = require('node:test');
const assert = require('node:assert/strict');

const frontendEnLocale = require('../../frontend/src/lib/i18n/locales/en.json');
const frontendRuLocale = require('../../frontend/src/lib/i18n/locales/ru.json');

const {
  appendLocaleParam,
  getEmailCopy,
  resolveEmailLocale
} = require('../../src/lib/server/email-templates/localization');

test('resolveEmailLocale prefers explicit locale, then cookie, then accept-language, then default', () => {
  assert.equal(resolveEmailLocale({ locale: 'ru-RU' }), 'ru');
  assert.equal(resolveEmailLocale({ req: { headers: { cookie: 'foo=1; archimap_locale=ru' } } }), 'ru');
  assert.equal(resolveEmailLocale({ req: { headers: { 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8' } } }), 'ru');
  assert.equal(resolveEmailLocale({}), 'en');
});

test('appendLocaleParam keeps existing query params and replaces lang', () => {
  const appended = new URL(appendLocaleParam('https://example.com/account/?registerToken=sample', 'ru'));
  assert.equal(appended.searchParams.get('registerToken'), 'sample');
  assert.equal(appended.searchParams.get('lang'), 'ru');

  const replaced = new URL(appendLocaleParam('https://example.com/?lang=en&resetToken=sample', 'ru'));
  assert.equal(replaced.searchParams.get('resetToken'), 'sample');
  assert.equal(replaced.searchParams.get('lang'), 'ru');
});

test('email copy is sourced from the shared locale json files', () => {
  const enCopy = getEmailCopy('en');
  const ruCopy = getEmailCopy('ru');

  assert.equal(enCopy.registration.subject, frontendEnLocale.email.registration.subject);
  assert.equal(enCopy.passwordReset.title, frontendEnLocale.email.passwordReset.title);
  assert.equal(
    enCopy.smtpTest.callout('admin@example.test'),
    frontendEnLocale.email.smtpTest.callout.replace('{email}', 'admin@example.test')
  );

  assert.equal(ruCopy.registration.subject, frontendRuLocale.email.registration.subject);
  assert.equal(ruCopy.passwordReset.validity(20), frontendRuLocale.email.passwordReset.validity.replace('{minutes}', '20'));
  assert.equal(
    ruCopy.smtpTest.callout('admin@example.test'),
    frontendRuLocale.email.smtpTest.callout.replace('{email}', 'admin@example.test')
  );
});
