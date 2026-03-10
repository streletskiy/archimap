const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  createPythonExtractResolver
} = require('../../scripts/region-sync/python-extractor');

const resolver = createPythonExtractResolver({
  importerPath: path.resolve(__dirname, '..', '..', 'scripts', 'sync-osm-buildings.py')
});

test('searchExtractCandidates returns canonical candidates for free-form query', async () => {
  const result = await resolver.searchExtractCandidates('Antarctica', {
    source: 'any',
    limit: 10
  });

  assert.equal(result.query, 'Antarctica');
  assert.ok(Array.isArray(result.items));
  assert.ok(result.items.some((item) => item.extractId === 'geofabrik_antarctica'));
});

test('resolveExactExtract validates canonical extract id with source', async () => {
  const result = await resolver.resolveExactExtract('geofabrik_antarctica', {
    source: 'geofabrik'
  });

  assert.equal(result.errorCode, null);
  assert.equal(result.candidate.extractSource, 'geofabrik');
  assert.equal(result.candidate.extractId, 'geofabrik_antarctica');
});

test('resolveExactExtract accepts path-style osmfr region ids from admin map data', async () => {
  const result = await resolver.resolveExactExtract('russia/central_federal_district/kostroma_oblast', {
    source: 'osmfr'
  });

  assert.equal(result.errorCode, null);
  assert.equal(result.candidate.extractSource, 'osmfr');
  assert.equal(result.candidate.extractId, 'osmfr_russia_central_federal_district_kostroma_oblast');
});

test('resolveExactExtract accepts path-style geofabrik us state ids from admin map data', async () => {
  const result = await resolver.resolveExactExtract('us/california', {
    source: 'geofabrik'
  });

  assert.equal(result.errorCode, null);
  assert.equal(result.candidate.extractSource, 'geofabrik');
  assert.equal(result.candidate.extractId, 'geofabrik_north-america_us_us_california');
});

test('resolveExactExtract reports ambiguous exact-name matches instead of auto-selecting one', async () => {
  const result = await resolver.resolveExactExtract('ceuta', {
    source: 'any'
  });

  assert.equal(result.candidate, null);
  assert.equal(result.errorCode, 'multiple');
  assert.match(String(result.message || ''), /Multiple extracts matched/i);
});
