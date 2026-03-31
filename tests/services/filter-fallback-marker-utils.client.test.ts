const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadFallbackMarkerUtils() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'filter-fallback-marker-utils.ts');
  return import(pathToFileURL(modulePath).href);
}

test('buildFilterFallbackMarkerGeojson jitters coordinates deterministically', async () => {
  const { buildFilterFallbackMarkerGeojson } = await loadFallbackMarkerUtils();
  const points = [{ id: 101, lon: 37.61, lat: 55.75, count: 3, osmKey: 'way/101' }];

  const first = buildFilterFallbackMarkerGeojson(points, '#ff6600');
  const second = buildFilterFallbackMarkerGeojson(points, '#ff6600');

  assert.deepEqual(first, second);
  assert.notDeepEqual(first.features[0].geometry.coordinates, [37.61, 55.75]);
  assert.equal(first.features[0].properties.match_count, 3);
});

test('applyFilterFallbackMarkerGroups builds search-like cluster layers without viewport translate', async () => {
  const {
    applyFilterFallbackMarkerGroups,
    getFilterFallbackSourceId,
    getFilterFallbackClusterLayerId,
    getFilterFallbackClusterCountLayerId,
    getFilterFallbackPointLayerId
  } = await loadFallbackMarkerUtils();

  const sources = new Map();
  const addedSources = [];
  const addedLayers = [];
  const removedLayers = [];
  const removedSources = [];

  const map = {
    getSource(sourceId) {
      return sources.get(sourceId) || null;
    },
    addSource(sourceId, source) {
      addedSources.push({ sourceId, source });
      sources.set(sourceId, {
        setData(data) {
          this.data = data;
        }
      });
    },
    removeSource(sourceId) {
      removedSources.push(sourceId);
      sources.delete(sourceId);
    },
    getLayer(layerId) {
      return addedLayers.some((layer) => layer.id === layerId) ? { id: layerId } : null;
    },
    addLayer(layer) {
      addedLayers.push(layer);
    },
    removeLayer(layerId) {
      removedLayers.push(layerId);
    }
  };

  applyFilterFallbackMarkerGroups({
    map,
    groups: [
      {
        color: '#ff6600',
        points: [
          { id: 101, lon: 37.61, lat: 55.75 },
          { id: 102, lon: 37.61, lat: 55.75 }
        ]
      }
    ]
  });

  const sourceId = getFilterFallbackSourceId('#ff6600');
  const clusterLayerId = getFilterFallbackClusterLayerId('#ff6600');
  const countLayerId = getFilterFallbackClusterCountLayerId('#ff6600');
  const pointLayerId = getFilterFallbackPointLayerId('#ff6600');

  assert.equal(addedSources.length, 1);
  assert.equal(addedSources[0].sourceId, sourceId);
  assert.equal(addedSources[0].source.clusterRadius, 48);
  assert.equal(addedSources[0].source.clusterMaxZoom, 16);
  assert.deepEqual(addedSources[0].source.clusterProperties, {
    match_count: ['+', ['get', 'match_count']]
  });
  assert.equal(addedLayers.some((layer) => layer.id === clusterLayerId), true);
  assert.equal(addedLayers.some((layer) => layer.id === countLayerId), true);
  assert.equal(addedLayers.some((layer) => layer.id === pointLayerId), true);
  assert.equal(Boolean(addedLayers.find((layer) => layer.id === clusterLayerId)?.paint?.['circle-translate']), false);
  assert.equal(Boolean(addedLayers.find((layer) => layer.id === pointLayerId)?.paint?.['circle-translate']), false);
  assert.equal(removedLayers.length, 0);
  assert.equal(removedSources.length, 0);
});
