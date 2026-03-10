const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadFilterCache() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'filter-cache.js');
  return import(pathToFileURL(modulePath).href);
}

test('findCachedFilterMatches returns the newest matching cached payload', async () => {
  const { createFilterCache } = await loadFilterCache();
  const cache = createFilterCache({
    ttlMs: 60_000,
    maxItems: 10
  });

  cache.putCachedFilterMatches('older', {
    meta: {
      rulesHash: 'r1',
      zoomBucket: 13,
      coverageWindow: { west: 0, south: 0, east: 10, north: 10 }
    },
    matchedCount: 10
  });
  cache.putCachedFilterMatches('newer', {
    meta: {
      rulesHash: 'r1',
      zoomBucket: 13,
      coverageWindow: { west: 1, south: 1, east: 9, north: 9 }
    },
    matchedCount: 11
  });

  const result = cache.findCachedFilterMatches((payload) => Number(payload?.matchedCount || 0) > 10);
  assert.equal(result?.matchedCount, 11);
});
