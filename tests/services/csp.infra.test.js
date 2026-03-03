const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCspDirectives, serializeCspDirectives } = require('../../src/lib/server/infra/csp.infra');

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
