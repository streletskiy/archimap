const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeUrl, maskSensitive } = require('../../src/lib/shared/log-sanitizer');

test('sanitizeUrl strips query string by default', () => {
  assert.equal(sanitizeUrl('/api/search?q=abc&token=secret'), '/api/search');
  assert.equal(sanitizeUrl('https://example.test/path?a=1'), 'https://example.test/path');
});

test('sanitizeUrl keeps only whitelisted query keys without values', () => {
  const value = sanitizeUrl('/api/buildings?bbox=1,2,3,4&limit=100&token=secret', {
    whitelistQueryKeys: ['bbox', 'limit']
  });
  assert.equal(value, '/api/buildings?bbox&limit');
});

test('maskSensitive redacts secrets in object payloads', () => {
  const masked = maskSensitive({
    password: 'p1',
    nested: {
      csrfToken: 'abc',
      normal: 'ok'
    },
    list: [{ token: 't' }, { value: 1 }]
  });
  assert.equal(masked.password, '[REDACTED]');
  assert.equal(masked.nested.csrfToken, '[REDACTED]');
  assert.equal(masked.nested.normal, 'ok');
  assert.equal(masked.list[0].token, '[REDACTED]');
  assert.equal(masked.list[1].value, 1);
});
