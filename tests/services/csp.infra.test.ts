const crypto = require('crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCspDirectives,
  serializeCspDirectives,
  extractInlineScriptHashesFromHtml
} = require('../../src/lib/server/infra/csp.infra');

let hooksServerImportCounter = 0;

function parseDelimitedValues(raw, delimiter = ',') {
  return String(raw || '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseCspDirectiveSources(csp, directiveName) {
  for (const directive of parseDelimitedValues(csp, ';')) {
    const [name, ...sources] = directive.split(/\s+/).filter(Boolean);
    if (name === directiveName) {
      return new Set(sources);
    }
  }
  return new Set();
}

async function loadHooksServerModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'hooks.server.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${hooksServerImportCounter += 1}`);
}

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

test('parseRuntimeEnv defaults CSP connect origins for carto and overpass fallback', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousConnectSrcExtra = process.env.CSP_CONNECT_SRC_EXTRA;
  process.env.NODE_ENV = 'development';
  delete process.env.CSP_CONNECT_SRC_EXTRA;

  try {
    const { parseRuntimeEnv } = require('../../src/lib/server/infra/env.infra');
    const runtimeEnv = parseRuntimeEnv({
      NODE_ENV: 'development',
      SESSION_SECRET: '1234567890abcdef'
    });
    const connectOrigins = new Set(parseDelimitedValues(runtimeEnv.cspConnectSrcExtra));

    assert.ok(connectOrigins.has('https://tiles.basemaps.cartocdn.com'));
    assert.ok(connectOrigins.has('https://api.maptiler.com'));
    assert.ok(connectOrigins.has('https://overpass-api.de'));
    assert.ok(connectOrigins.has('https://overpass.kumi.systems'));
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;

    if (previousConnectSrcExtra === undefined) delete process.env.CSP_CONNECT_SRC_EXTRA;
    else process.env.CSP_CONNECT_SRC_EXTRA = previousConnectSrcExtra;
  }
});

test('frontend hook CSP allows browser Overpass requests by default', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousConnectSrcExtra = process.env.CSP_CONNECT_SRC_EXTRA;
  process.env.NODE_ENV = 'production';
  delete process.env.CSP_CONNECT_SRC_EXTRA;

  try {
    const { handle } = await loadHooksServerModule();
    const response = await handle({
      event: {
        request: new Request('http://localhost/'),
        url: new URL('http://localhost/')
      },
      resolve: async () => new Response('<!doctype html><html><head></head><body>ok</body></html>', {
        headers: {
          'content-type': 'text/html; charset=utf-8'
        }
      })
    });

    const csp = String(response.headers.get('content-security-policy') || '');
    const connectSrc = parseCspDirectiveSources(csp, 'connect-src');
    assert.ok(connectSrc.size > 0);
    assert.ok(connectSrc.has('https://tiles.basemaps.cartocdn.com'));
    assert.ok(connectSrc.has('https://api.maptiler.com'));
    assert.ok(connectSrc.has('https://overpass-api.de'));
    assert.ok(connectSrc.has('https://maps.mail.ru'));
    assert.equal(/\bscript-src\s[^;]*unsafe-inline/.test(csp), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;

    if (previousConnectSrcExtra === undefined) delete process.env.CSP_CONNECT_SRC_EXTRA;
    else process.env.CSP_CONNECT_SRC_EXTRA = previousConnectSrcExtra;
  }
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
