const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  fetchRemoteJson,
  resolveLocalBasemapGlyphPath,
  rewriteCustomBasemapTileJson
} = require('../../src/lib/server/services/basemap-proxy.service');

test('rewriteCustomBasemapTileJson proxies tile templates through absolute same-origin routes', () => {
  const input = {
    name: 'Custom basemap',
    tiles: ['/current/{z}/{x}/{y}.mvt']
  };

  const result = rewriteCustomBasemapTileJson(
    input,
    'https://tiles.example.com/current.json',
    'secret-key',
    'https://app.example.com'
  );

  assert.notEqual(result, input);
  assert.equal(result.name, 'Custom basemap');
  assert.deepEqual(result.tiles, [
    'https://app.example.com/api/basemaps/custom/tiles?u=https%3A%2F%2Ftiles.example.com%2Fcurrent%2F%7Bz%7D%2F%7Bx%7D%2F%7By%7D.mvt%3Fkey%3Dsecret-key&z={z}&x={x}&y={y}'
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'url'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'tilejson'), false);
});

test('fetchRemoteJson retries localhost on loopback fallback', async () => {
  const requestedUrls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).includes('localhost') || String(url).includes('127.0.0.1') || String(url).includes('[::1]')) {
      throw new TypeError('fetch failed');
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  };

  try {
    const result = await fetchRemoteJson('http://localhost:8080/current.json');

    assert.deepEqual(result, { ok: true });
    assert.equal(requestedUrls[0], 'http://localhost:8080/current.json');
    assert.equal(requestedUrls[1], 'http://127.0.0.1:8080/current.json');
    assert.equal(requestedUrls[2], 'http://[::1]:8080/current.json');
    assert.equal(requestedUrls[3], 'http://host.docker.internal:8080/current.json');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('resolveLocalBasemapGlyphPath falls back to local Noto glyphs for Open Sans aliases', () => {
  const result = resolveLocalBasemapGlyphPath(process.cwd(), 'Open Sans Bold', '0-255.pbf');

  assert.match(result, /frontend[\\\/](?:build[\\\/]client|static)[\\\/]basemaps-assets[\\\/]fonts[\\\/]Noto Sans Medium[\\\/]0-255\.pbf$/);
});

test('resolveLocalBasemapGlyphPath prefers built client assets when they exist', () => {
  const tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-glyphs-'));
  const builtGlyphPath = path.join(
    tempRootDir,
    'frontend',
    'build',
    'client',
    'basemaps-assets',
    'fonts',
    'Noto Sans Medium',
    '0-255.pbf'
  );
  const staticGlyphPath = path.join(
    tempRootDir,
    'frontend',
    'static',
    'basemaps-assets',
    'fonts',
    'Noto Sans Medium',
    '0-255.pbf'
  );

  try {
    fs.mkdirSync(path.dirname(builtGlyphPath), { recursive: true });
    fs.mkdirSync(path.dirname(staticGlyphPath), { recursive: true });
    fs.writeFileSync(builtGlyphPath, 'built');
    fs.writeFileSync(staticGlyphPath, 'static');

    const result = resolveLocalBasemapGlyphPath(tempRootDir, 'Open Sans Bold', '0-255.pbf');

    assert.equal(result, builtGlyphPath);
  } finally {
    fs.rmSync(tempRootDir, { recursive: true, force: true });
  }
});

test('resolveLocalBasemapGlyphPath decodes encoded fontstack segments before lookup', () => {
  const result = resolveLocalBasemapGlyphPath(process.cwd(), 'Noto%20Sans%20Regular', '0-255.pbf');

  assert.match(result, /frontend[\\\/](?:build[\\\/]client|static)[\\\/]basemaps-assets[\\\/]fonts[\\\/]Noto Sans Regular[\\\/]0-255\.pbf$/);
});

test('resolveLocalBasemapGlyphPath rejects traversal-like input', () => {
  const result = resolveLocalBasemapGlyphPath(process.cwd(), '../Noto Sans Medium', '0-255.pbf');

  assert.equal(result, '');
});
