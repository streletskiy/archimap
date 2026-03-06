const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCspDirectives,
  serializeCspDirectives,
  extractInlineScriptHashesFromHtml
} = require('../../src/lib/server/infra/csp.infra');

test('csp prod profile has no unsafe-inline', () => {
  const directives = buildCspDirectives({
    nodeEnv: 'production',
    extraConnectOrigins: ['https://tiles.basemaps.cartocdn.com']
  });
  const csp = serializeCspDirectives(directives);
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(csp.includes("style-src 'self'"));
  assert.equal(/\bscript-src\s[^;]*unsafe-inline/.test(csp), false);
  assert.equal(/\bstyle-src\s[^;]*unsafe-inline/.test(csp), false);
});

test('csp dev profile allows ws/wss connect for local tooling', () => {
  const directives = buildCspDirectives({
    nodeEnv: 'development'
  });
  const csp = serializeCspDirectives(directives);
  assert.ok(csp.includes('connect-src'));
  assert.ok(csp.includes('ws:'));
  assert.ok(csp.includes('wss:'));
});

test('extractInlineScriptHashesFromHtml tolerates spaced and malformed script closing tags', () => {
  const firstBody = 'window.__ARCHIMAP__ = { ready: true };';
  const secondBody = 'console.log("inline");';
  const expected = [firstBody, secondBody].map((body) => (
    `'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`
  ));

  const hashes = extractInlineScriptHashesFromHtml(`
    <script>${firstBody}</script   >
    <script>${secondBody}</script foo="bar">
    <script src="/assets/app.js"></script >
  `);

  assert.deepEqual(hashes, expected);
});
