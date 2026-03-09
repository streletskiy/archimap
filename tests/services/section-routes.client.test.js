const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadSectionRoutesModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'client', 'section-routes.js');
  return import(pathToFileURL(modulePath).href);
}

test('resolveInfoTabFromUrl keeps legacy info query compatibility on section root', async () => {
  const { resolveInfoTabFromUrl } = await loadSectionRoutesModule();

  assert.equal(resolveInfoTabFromUrl('http://localhost/app/info?tab=legal&doc=terms'), 'agreement');
  assert.equal(resolveInfoTabFromUrl('http://localhost/app/info?tab=legal&doc=privacy'), 'privacy');
  assert.equal(resolveInfoTabFromUrl('http://localhost/app/info'), 'about');
});

test('resolveAccountTabFromUrl and resolveAdminTabFromUrl keep legacy query compatibility on section root', async () => {
  const { resolveAccountTabFromUrl, resolveAdminTabFromUrl } = await loadSectionRoutesModule();

  assert.equal(resolveAccountTabFromUrl('http://localhost/app/account?tab=history'), 'edits');
  assert.equal(resolveAdminTabFromUrl('http://localhost/app/admin?tab=users'), 'users');
  assert.equal(resolveAdminTabFromUrl('http://localhost/app/admin?adminEdit=42'), 'edits');
});
