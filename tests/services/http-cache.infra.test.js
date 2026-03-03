const test = require('node:test');
const assert = require('node:assert/strict');
const { createWeakEtag, isResourceNotModified, toHttpDate } = require('../../src/lib/server/infra/http-cache.infra');
const { parseRangeHeader } = require('../../src/lib/server/infra/pmtiles-stream.infra');

test('createWeakEtag returns deterministic weak etag', () => {
  const a = createWeakEtag(Buffer.from('{"ok":true}', 'utf8'));
  const b = createWeakEtag(Buffer.from('{"ok":true}', 'utf8'));
  const c = createWeakEtag(Buffer.from('{"ok":false}', 'utf8'));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^W\/"/);
});

test('isResourceNotModified supports If-None-Match and If-Modified-Since', () => {
  const lastModified = toHttpDate(new Date('2026-03-03T00:00:00.000Z'));
  assert.equal(isResourceNotModified({
    headers: { 'if-none-match': 'W/"abc", W/"def"' }
  }, { etag: 'W/"def"', lastModified }), true);

  assert.equal(isResourceNotModified({
    headers: { 'if-modified-since': 'Tue, 03 Mar 2026 00:00:00 GMT' }
  }, { etag: null, lastModified }), true);
});

test('parseRangeHeader parses valid byte ranges and rejects invalid values', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-1023', 4096), { start: 0, end: 1023 });
  assert.deepEqual(parseRangeHeader('bytes=1024-', 4096), { start: 1024, end: 4095 });
  assert.deepEqual(parseRangeHeader('bytes=-256', 4096), { start: 3840, end: 4095 });
  assert.equal(parseRangeHeader('bytes=5000-6000', 4096), null);
  assert.equal(parseRangeHeader('items=0-1', 4096), null);
});
