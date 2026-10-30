const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createWeakEtag,
  isResourceNotModified,
  sendCachedJson,
  sendCompressedJson,
  toHttpDate
} = require('../../src/lib/server/infra/http-cache.infra');
const { parseRangeHeader } = require('../../src/lib/server/infra/pmtiles-stream.infra');

function createJsonResponseStub() {
  const headers = new Map();
  return {
    statusCode: null,
    body: null,
    ended: false,
    headers,
    type(value) {
      this.setHeader('Content-Type', value);
      return this;
    },
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
      return this;
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = Buffer.isBuffer(body) ? body.toString('utf8') : body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    }
  };
}

test('createWeakEtag returns deterministic weak etag', () => {
  const a = createWeakEtag(Buffer.from('{"ok":true}', 'utf8'));
  const b = createWeakEtag(Buffer.from('{"ok":true}', 'utf8'));
  const c = createWeakEtag(Buffer.from('{"ok":false}', 'utf8'));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^W\/"/);
});

test('If-None-Match takes precedence over an unchanged modification date', () => {
  assert.equal(isResourceNotModified({ headers: { 'if-none-match': 'W/"old"', 'if-modified-since': 'Fri, 30 Oct 2026 12:00:00 GMT' } },
    { etag: 'W/"new"', lastModified: 'Fri, 30 Oct 2026 12:00:00 GMT' }), false);
});

test('large cached responses compress asynchronously and preserve their body', async () => {
  const zlib = require('node:zlib');
  const payload = { items: Array.from({ length: 20000 }, (_, i) => ({ id: i, value: `building-${i}` })) };
  const res = createJsonResponseStub(); res.send = function (body) { this.body = body; return this; };
  const pending = sendCachedJson({ method: 'GET', headers: { 'accept-encoding': 'br' } }, res, payload);
  assert.equal(res.body, null);
  await pending;
  assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(res.body).toString()), payload);
});

test('sendCompressedJson negotiates encoding and preserves private POST payloads', async () => {
  const zlib = require('node:zlib');
  const payload = { matchedKeys: Array.from({ length: 500 }, (_, index) => `way/${index}`) };
  for (const [accept, encoding] of [['br, gzip', 'br'], ['br;q=0, gzip;q=0.8', 'gzip'], ['br;q=0, gzip;q=0', null]]) {
    const res = createJsonResponseStub();
    res.send = function (body) { this.body = body; return this; };
    await sendCompressedJson({ method: 'POST', headers: { 'accept-encoding': accept, 'if-none-match': '*' } }, res, payload);
    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader('content-encoding') || null, encoding);
    assert.equal(res.getHeader('cache-control'), 'private, no-store');
    assert.equal(res.getHeader('vary'), 'Accept-Encoding');
    assert.equal(res.getHeader('etag'), undefined);
    const decoded = encoding === 'br' ? zlib.brotliDecompressSync(res.body)
      : encoding === 'gzip' ? zlib.gunzipSync(res.body) : res.body;
    assert.deepEqual(JSON.parse(decoded.toString()), payload);
    if (encoding) assert.ok(res.body.length < decoded.length / 2);
  }
});

test('sendCachedJson can derive ETag from a safe payload instead of the response body', () => {
  const req = {
    headers: {},
    method: 'GET'
  };
  const first = createJsonResponseStub();
  const second = createJsonResponseStub();
  const third = createJsonResponseStub();

  sendCachedJson(req, first, { url: 'https://tiles.example.test/{z}/{x}/{y}.mvt?key=secret-one' }, {
    etagPayload: {
      url: 'https://tiles.example.test/{z}/{x}/{y}.mvt',
      settingsVersion: '2026-06-15T12:00:00Z'
    }
  });
  sendCachedJson(req, second, { url: 'https://tiles.example.test/{z}/{x}/{y}.mvt?key=secret-two' }, {
    etagPayload: {
      url: 'https://tiles.example.test/{z}/{x}/{y}.mvt',
      settingsVersion: '2026-06-15T12:00:00Z'
    }
  });
  sendCachedJson(req, third, { url: 'https://tiles.example.test/{z}/{x}/{y}.mvt?key=secret-two' }, {
    etagPayload: {
      url: 'https://tiles.example.test/{z}/{x}/{y}.mvt',
      settingsVersion: '2026-06-15T12:00:01Z'
    }
  });

  assert.equal(first.getHeader('etag'), second.getHeader('etag'));
  assert.notEqual(first.getHeader('etag'), third.getHeader('etag'));
  assert.match(first.body, /secret-one/);
  assert.match(second.body, /secret-two/);
});

test('isResourceNotModified supports If-None-Match and If-Modified-Since', () => {
  const lastModified = toHttpDate(new Date('2026-03-03T00:00:00.000Z'));
  assert.equal(
    isResourceNotModified(
      {
        headers: { 'if-none-match': 'W/"abc", W/"def"' }
      },
      { etag: 'W/"def"', lastModified }
    ),
    true
  );

  assert.equal(
    isResourceNotModified(
      {
        headers: { 'if-modified-since': 'Tue, 03 Mar 2026 00:00:00 GMT' }
      },
      { etag: null, lastModified }
    ),
    true
  );
});

test('parseRangeHeader parses valid byte ranges and rejects invalid values', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-1023', 4096), { start: 0, end: 1023 });
  assert.deepEqual(parseRangeHeader('bytes=1024-', 4096), { start: 1024, end: 4095 });
  assert.deepEqual(parseRangeHeader('bytes=-256', 4096), { start: 3840, end: 4095 });
  assert.equal(parseRangeHeader('bytes=5000-6000', 4096), null);
  assert.equal(parseRangeHeader('items=0-1', 4096), null);
});
