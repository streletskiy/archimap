const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadFilterMatchCacheStrategy() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'filter-match-cache-strategy.ts');
  return import(pathToFileURL(modulePath).href);
}

async function loadFilterCache() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'filter-cache.ts');
  return import(pathToFileURL(modulePath).href);
}

test('findReusableResolvedPayload rejects cached payloads from a different overpass data version', async () => {
  const { createFilterMatchCacheStrategy } = await loadFilterMatchCacheStrategy();
  const { createFilterCache } = await loadFilterCache();

  const filterCache = createFilterCache({
    ttlMs: 60_000,
    maxItems: 10
  });

  filterCache.putCachedFilterMatches('request:layer:fnv1a-test:coverage-test:14:contours:1', {
    matchedKeys: ['way/101'],
    matchedFeatureIds: [202],
    meta: {
      rulesHash: 'fnv1a-test',
      bboxHash: 'bbox-test',
      truncated: false,
      elapsedMs: 5,
      cacheHit: false,
      renderMode: 'contours',
      coverageHash: 'coverage-test',
      coverageWindow: { west: 0, south: 0, east: 10, north: 10 },
      zoomBucket: 14,
      dataVersion: 1
    }
  });

  const strategy = createFilterMatchCacheStrategy({
    filterCache,
    filterFetcher: {
      fetchFilterMatchesPrimary: async () => ({}),
      fetchFilterMatchesFallback: async () => ({}),
      fetchFilterMatchesBatchPrimary: async () => ({ items: [] })
    },
    buildFilterRequestCacheKey: (spec, coverageHash, zoomBucket, renderMode, dataVersion = 0) => (
      `request:${spec.id}:${spec.rulesHash}:${coverageHash}:${zoomBucket}:${renderMode || 'contours'}:${Math.max(0, Math.trunc(Number(dataVersion) || 0))}`
    ),
    buildPrefetchCoverageWindow: (coverageWindow) => coverageWindow,
    resolveMap: () => null,
    getLatestFilterToken: () => 1,
    recordFilterRequestDebugEvent: () => {},
    recordFilterTelemetry: () => {}
  });

  const reusable = strategy.findReusableResolvedPayload({
    viewportBbox: { west: 1, south: 1, east: 9, north: 9 },
    rulesHash: 'fnv1a-test',
    zoomBucket: 14,
    renderMode: 'contours',
    dataVersion: 1
  });
  const stale = strategy.findReusableResolvedPayload({
    viewportBbox: { west: 1, south: 1, east: 9, north: 9 },
    rulesHash: 'fnv1a-test',
    zoomBucket: 14,
    renderMode: 'contours',
    dataVersion: 2
  });

  assert.equal(Boolean(reusable), true);
  assert.equal(stale, null);
});
