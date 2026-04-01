const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadFilterFetcher() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'filter-fetcher.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${importCounter += 1}`);
}

test('createFilterFetcher includes building part layers when resolving visible filter keys', async () => {
  const previousFetch = global.fetch;
  const queriedLayers = [];
  const requestedBodies = [];

  global.fetch = (async (input, init: RequestInit = {}) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requestedBodies.push({
      input: String(input),
      body
    });
      return new Response(JSON.stringify({
        items: (Array.isArray(body.keys) ? body.keys : []).map((key) => ({
          osmKey: key,
          centerLon: key === 'way/202' ? 37.62 : 37.61,
          centerLat: key === 'way/202' ? 55.76 : 55.75,
          sourceTags: {
            name: key === 'way/202' ? 'Part building' : 'Main building'
          }
        }))
      }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const { createFilterFetcher } = await loadFilterFetcher();
    const fetcher = createFilterFetcher({
      resolveMap: () => ({
        getLayer(layerId) {
          return { id: layerId };
        },
        queryRenderedFeatures(query: LooseRecord = {}) {
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
    assert.deepEqual(result.matchedLocations, [
      { id: 202, lon: 37.61, lat: 55.75, osmKey: 'way/101', count: 1 },
      { id: 404, lon: 37.62, lat: 55.76, osmKey: 'way/202', count: 1 }
    ]);
    assert.equal(result.meta.rulesHash, 'fnv1a-test');
    assert.equal(result.meta.bboxHash, 'bbox-test');
  } finally {
    global.fetch = previousFetch;
  }
});

test('createFilterFetcher ignores missing overpass layers when resolving visible filter keys', async () => {
  const previousFetch = global.fetch;
  const queriedLayers = [];
  const requestedBodies = [];

  global.fetch = (async (input, init: RequestInit = {}) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requestedBodies.push({
      input: String(input),
      body
    });
    return new Response(JSON.stringify({
      items: (Array.isArray(body.keys) ? body.keys : []).map((key) => ({
        osmKey: key,
        centerLon: key === 'way/202' ? 37.62 : 37.61,
        centerLat: key === 'way/202' ? 55.76 : 55.75,
        sourceTags: {
          name: key === 'way/202' ? 'Part building' : 'Main building'
        }
      }))
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const { createFilterFetcher } = await loadFilterFetcher();
    const fetcher = createFilterFetcher({
      resolveMap: () => ({
        getLayer(layerId) {
          if (String(layerId || '').startsWith('overpass-buildings-source-')) return null;
          return { id: layerId };
        },
        queryRenderedFeatures(query: LooseRecord = {}) {
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
        buildingFillLayerIds: ['building-fill', 'overpass-buildings-source-fill'],
        buildingLineLayerIds: ['building-line', 'overpass-buildings-source-line'],
        buildingPartFillLayerIds: ['part-fill', 'overpass-buildings-source-part-fill'],
        buildingPartLineLayerIds: ['part-line', 'overpass-buildings-source-part-line']
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
  } finally {
    global.fetch = previousFetch;
  }
});

test('createFilterFetcher merges locally loaded overpass buildings into primary filter matches', async () => {
  const previousFetch = global.fetch;
  const requestedBodies = [];

  global.fetch = (async (input, init: RequestInit = {}) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requestedBodies.push({
      input: String(input),
      body
    });
    return new Response(JSON.stringify({
      matchedKeys: [],
      matchedFeatureIds: [],
      matchedLocations: [],
      meta: {
        rulesHash: 'fnv1a-test',
        bboxHash: 'bbox-test',
        truncated: false,
        elapsedMs: 3,
        cacheHit: false
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const { createFilterFetcher } = await loadFilterFetcher();
    const fetcher = createFilterFetcher({
      resolveMap: () => ({
        getLayer() {
          return { id: 'layer' };
        },
        getSource(sourceId) {
          return sourceId === 'overpass-buildings-source' ? { id: sourceId } : null;
        },
        queryRenderedFeatures() {
          return [];
        },
        querySourceFeatures(sourceId) {
          if (sourceId !== 'overpass-buildings-source') return [];
          return [
            {
              id: 101,
              geometry: {
                type: 'Point',
                coordinates: [37.61, 55.75]
              },
              properties: {
                osm_type: 'way',
                osm_id: 101,
                source_tags: {
                  name: 'Main building',
                  style: 'Constructivism',
                  levels: '5'
                },
                archiInfo: {
                  name: 'Main building'
                }
              }
            },
            {
              id: 202,
              geometry: {
                type: 'Point',
                coordinates: [37.62, 55.76]
              },
              properties: {
                osm_type: 'way',
                osm_id: 202,
                source_tags: {
                  name: 'Side building',
                  style: 'Modern',
                  levels: '3'
                },
                archiInfo: {
                  name: 'Side building'
                }
              }
            }
          ];
        }
      }),
      resolveLayerIds: () => ({
        buildingFillLayerIds: ['building-fill'],
        buildingLineLayerIds: ['building-line'],
        buildingPartFillLayerIds: ['part-fill'],
        buildingPartLineLayerIds: ['part-line']
      }),
      resolveBuildingSourceConfigs: () => [
        { sourceId: 'overpass-buildings-source' }
      ],
      getCurrentRulesHash: () => 'fnv1a-test',
      getLastViewportHash: () => 'bbox-test',
      matchDefaultLimit: 25,
      dataCacheTtlMs: 60_000,
      dataCacheMaxItems: 10,
      dataRequestChunkSize: 10
    });

    const result = await fetcher.fetchFilterMatchesPrimary({
      bbox: { west: 37.6, south: 55.74, east: 37.63, north: 55.77 },
      zoomBucket: 14.5,
      rules: [{ key: 'name', op: 'contains', value: 'Main' }],
      rulesHash: 'fnv1a-test',
      maxResults: 25,
      renderMode: 'contours',
      dataVersion: 7
    });

    assert.equal(requestedBodies[0].body.maxResults, 25);
    assert.deepEqual(result.matchedKeys, ['way/101']);
    assert.deepEqual(result.matchedFeatureIds, [202]);
    assert.deepEqual(result.matchedLocations, [
      { id: 202, lon: 37.61, lat: 55.75, count: 1, osmKey: 'way/101' }
    ]);
    assert.equal(result.meta.dataVersion, 7);
  } finally {
    global.fetch = previousFetch;
  }
});

test('createFilterFetcher derives filterable levels from local pmtiles render heights', async () => {
  const previousFetch = global.fetch;
  let fetchCalls = 0;

  global.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const { createFilterFetcher } = await loadFilterFetcher();
    const fetcher = createFilterFetcher({
      resolveMap: () => ({
        getLayer() {
          return { id: 'layer' };
        },
        getSource(sourceId) {
          return sourceId === 'region-buildings-source' ? { id: sourceId } : null;
        },
        queryRenderedFeatures() {
          return [{
            properties: {
              osm_type: 'relation',
              osm_id: 203
            }
          }];
        },
        querySourceFeatures(sourceId) {
          if (sourceId !== 'region-buildings-source') return [];
          return [{
            id: 407,
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [30, 60],
                [30.01, 60],
                [30.01, 60.01],
                [30, 60.01],
                [30, 60]
              ]]
            },
            properties: {
              osm_type: 'relation',
              osm_id: 203,
              feature_kind: 'building_part',
              render_height_m: 18.5,
              render_min_height_m: 5.5
            }
          }];
        }
      }),
      resolveLayerIds: () => ({
        buildingFillLayerIds: ['building-fill'],
        buildingLineLayerIds: ['building-line'],
        buildingPartFillLayerIds: ['part-fill'],
        buildingPartLineLayerIds: ['part-line']
      }),
      resolveBuildingSourceConfigs: () => [
        { sourceId: 'region-buildings-source', sourceLayer: 'buildings' }
      ],
      getCurrentRulesHash: () => 'fnv1a-levels',
      getLastViewportHash: () => 'bbox-levels',
      matchDefaultLimit: 25,
      dataCacheTtlMs: 60_000,
      dataCacheMaxItems: 10,
      dataRequestChunkSize: 10
    });

    const result = await fetcher.fetchFilterMatchesFallback({
      rules: [{ key: 'levels', op: 'greater_or_equals', value: '4', valueNormalized: '4', numericValue: 4 }]
    });

    assert.deepEqual(result.matchedKeys, ['relation/203']);
    assert.deepEqual(result.matchedFeatureIds, [407]);
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = previousFetch;
  }
});

test('createFilterFetcher forwards per-request maxResults to filter-matches', async () => {
  const previousFetch = global.fetch;
  const requestedBodies = [];

  global.fetch = (async (input, init: RequestInit = {}) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requestedBodies.push({
      input: String(input),
      body
    });
    return new Response(JSON.stringify({
      matchedKeys: [],
      matchedFeatureIds: [],
      matchedLocations: [],
      meta: {
        rulesHash: 'fnv1a-test',
        bboxHash: 'bbox-test',
        truncated: false,
        elapsedMs: 4,
        cacheHit: false
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const { createFilterFetcher } = await loadFilterFetcher();
    const fetcher = createFilterFetcher({
      resolveMap: () => null,
      resolveLayerIds: () => ({
        buildingFillLayerIds: [],
        buildingLineLayerIds: [],
        buildingPartFillLayerIds: [],
        buildingPartLineLayerIds: []
      }),
      resolveBuildingSourceConfigs: () => [],
      getCurrentRulesHash: () => 'fnv1a-test',
      getLastViewportHash: () => 'bbox-test',
      matchDefaultLimit: 12000,
      dataCacheTtlMs: 60_000,
      dataCacheMaxItems: 10,
      dataRequestChunkSize: 10
    });

    await fetcher.fetchFilterMatchesPrimary({
      bbox: { west: 0, south: 0, east: 1, north: 1 },
      zoomBucket: 12.5,
      rules: [{ key: 'name', op: 'contains', value: 'alpha' }],
      rulesHash: 'fnv1a-test',
      maxResults: 321,
      renderMode: 'markers'
    });

    assert.equal(requestedBodies[0].body.maxResults, 321);
    assert.equal(requestedBodies[0].body.renderMode, 'markers');
  } finally {
    global.fetch = previousFetch;
  }
});

