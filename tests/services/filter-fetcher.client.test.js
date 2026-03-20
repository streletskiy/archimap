const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadFilterFetcher() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'filter-fetcher.js');
  return import(`${pathToFileURL(modulePath).href}?v=${importCounter += 1}`);
}

test('createFilterFetcher includes building part layers when resolving visible filter keys', async () => {
  const previousFetch = global.fetch;
  const queriedLayers = [];
  const requestedBodies = [];

  global.fetch = async (input, init = {}) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requestedBodies.push({
      input: String(input),
      body
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        items: (Array.isArray(body.keys) ? body.keys : []).map((key) => ({
          osmKey: key,
          sourceTags: {
            name: key === 'way/202' ? 'Part building' : 'Main building'
          }
        }))
      })
    };
  };

  try {
    const { createFilterFetcher } = await loadFilterFetcher();
    const fetcher = createFilterFetcher({
      resolveMap: () => ({
        queryRenderedFeatures(query = {}) {
          queriedLayers.push([...(query.layers || [])]);
          return [
            {
              properties: {
                osm_type: 'way',
                osm_id: 101
              }
            },
            {
              properties: {
                osm_type: 'way',
                osm_id: 202
              }
            }
          ];
        },
        getSource() {
          return null;
        }
      }),
      resolveLayerIds: () => ({
        buildingFillLayerIds: ['building-fill'],
        buildingLineLayerIds: ['building-line'],
        buildingPartFillLayerIds: ['part-fill'],
        buildingPartLineLayerIds: ['part-line']
      }),
      resolveBuildingSourceConfigs: () => [],
      getCurrentRulesHash: () => 'fnv1a-test',
      getLastViewportHash: () => 'bbox-test',
      matchDefaultLimit: 25,
      dataCacheTtlMs: 60_000,
      dataCacheMaxItems: 10,
      dataRequestChunkSize: 10
    });

    const result = await fetcher.fetchFilterMatchesFallback({
      rules: []
    });

    assert.deepEqual(queriedLayers[0], [
      'building-fill',
      'building-line',
      'part-fill',
      'part-line'
    ]);
    assert.deepEqual(requestedBodies[0].body.keys, ['way/101', 'way/202']);
    assert.deepEqual(result.matchedKeys, ['way/101', 'way/202']);
    assert.deepEqual(result.matchedFeatureIds, [202, 404]);
    assert.equal(result.meta.rulesHash, 'fnv1a-test');
    assert.equal(result.meta.bboxHash, 'bbox-test');
  } finally {
    global.fetch = previousFetch;
  }
});
