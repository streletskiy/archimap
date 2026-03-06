const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadSelectionUtils() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'components', 'map', 'selection-utils.js');
  return import(pathToFileURL(modulePath).href);
}

test('getFeatureIdentity resolves osm_key first', async () => {
  const { getFeatureIdentity } = await loadSelectionUtils();
  const identity = getFeatureIdentity({
    id: 999,
    properties: {
      osm_key: 'way/321',
      osm_type: 'relation',
      osm_id: 777
    }
  });
  assert.deepEqual(identity, { osmType: 'way', osmId: 321 });
});

test('getFeatureIdentity falls back to encoded feature id', async () => {
  const { getFeatureIdentity, encodeOsmFeatureId } = await loadSelectionUtils();
  const identity = getFeatureIdentity({
    id: encodeOsmFeatureId('relation', 42),
    properties: {}
  });
  assert.deepEqual(identity, { osmType: 'relation', osmId: 42 });
});

test('getFeatureIdentity infers relation for multipolygon with osm_id', async () => {
  const { getFeatureIdentity } = await loadSelectionUtils();
  const identity = getFeatureIdentity({
    properties: {
      osm_id: 777
    },
    geometry: {
      type: 'MultiPolygon'
    }
  });
  assert.deepEqual(identity, { osmType: 'relation', osmId: 777 });
});

test('getSelectionFilter is deterministic for same building and switches for different buildings', async () => {
  const { getSelectionFilter } = await loadSelectionUtils();

  const first = getSelectionFilter(null, { osmType: 'way', osmId: 10 });
  const firstAgain = getSelectionFilter(null, { osmType: 'way', osmId: 10 });
  const second = getSelectionFilter(null, { osmType: 'way', osmId: 11 });

  assert.deepEqual(first, firstAgain);
  assert.notDeepEqual(first, second);
});
