const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadI18n() {
  const file = pathToFileURL(path.join(process.cwd(), 'frontend', 'src', 'lib', 'i18n', 'index.ts')).href;
  return import(file);
}

test('i18n fallback uses default language key when locale value is missing', async () => {
  const i18n = await loadI18n();
  i18n.setLocale('ru');
  const result = i18n.translateNow('errors.network');
  assert.equal(typeof result, 'string');
  assert.notEqual(result.length, 0);
});

test('i18n missing key logs warning in non-production', async () => {
  const i18n = await loadI18n();
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const output = i18n.translateNow('missing.key.path');
    assert.equal(output, 'missing.key.path');
    assert.equal(warnings.some((line) => line.includes('Missing key')), true);
  } finally {
    console.warn = originalWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test('locale switch changes translated output', async () => {
  const i18n = await loadI18n();
  i18n.setLocale('en');
  const enValue = i18n.translateNow('header.login');
  i18n.setLocale('ru');
  const ruValue = i18n.translateNow('header.login');

  assert.notEqual(enValue, ruValue);
});

