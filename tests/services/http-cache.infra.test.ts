const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createWeakEtag,
  isResourceNotModified,
  sendCachedJson,
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
