const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpstreamDomain } = require('../../src/lib/server/services/data-settings/upstream');

function context(extract, fetchImpl) {
  return {
    ensureBootstrapped: async () => {},
    fetchImpl,
    now: () => '2026-01-02T00:01:00Z',
    toIsoOrNull: (value) => {
      const parsed = Date.parse(String(value || ''));
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
    },
    regionCatalog: { findEntry: () => extract },
    state: { upstreamMetadataByKey: new Map() }
  };
}
function region(extract) {
  return {
    ...extract,
    extractResolutionStatus: 'resolved',
    lastSuccessfulSyncAt: '2026-01-01T00:00:00Z',
    sourceDataUpdatedAt: '2026-01-01T00:00:00Z'
  };
}

for (const fixture of [
  {
    extractSource: 'geofabrik',
    extractId: 'europe/finland',
    downloadUrl: 'https://download.geofabrik.de/europe/finland-latest.osm.pbf',
    expected: 'https://download.geofabrik.de/europe/finland-updates/state.txt'
  },
  {
    extractSource: 'osmfr',
    extractId: 'europe/france/alsace',
    downloadUrl: 'https://download.openstreetmap.fr/extracts/europe/france/alsace.osm.pbf',
    expected: 'https://download.openstreetmap.fr/replication/europe/france/alsace/minute/state.txt'
  }
]) {
  test(`${fixture.extractSource} freshness uses its regional replication state and caches UI probes`, async () => {
    const calls = [];
    const service = createUpstreamDomain(
      context(fixture, async (url, options) => {
        calls.push({ url, method: options.method });
        return new Response('sequenceNumber=123\ntimestamp=2026-01-02T00\\:00\\:00Z\n', { status: 200 });
      })
    );
    const first = await service.getRegionUpstreamState(region(fixture));
    assert.equal(first.upstreamStatus, 'update_available');
    assert.equal(first.latestSourceDataUpdatedAt, '2026-01-02T00:00:00.000Z');
    await service.getRegionUpstreamState(region(fixture));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, fixture.expected);
    assert.notEqual(calls[0].method, 'HEAD');
    await service.getRegionUpstreamState(region(fixture), { forceRefresh: true });
    assert.equal(calls.length, 2);
  });
}

test('failed regional replication probe stays unknown instead of declaring old daily data current', async () => {
  const extract = {
    extractSource: 'geofabrik',
    extractId: 'europe/finland',
    downloadUrl: 'https://download.geofabrik.de/europe/finland-latest.osm.pbf'
  };
  let calls = 0;
  const service = createUpstreamDomain(
    context(extract, async () => {
      calls++;
      return new Response('', { status: 503 });
    })
  );
  const result = await service.getRegionUpstreamState(region(extract));
  assert.equal(result.upstreamStatus, 'error');
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latestSourceDataUpdatedAt, null);
  assert.equal(calls, 1);
});

test('unsupported source does not use an arbitrary supplied replication URL', async () => {
  const extract = {
    extractSource: 'custom',
    extractId: 'test',
    downloadUrl: 'https://example.test/data.pbf',
    stateUrl: 'http://127.0.0.1/private'
  };
  const calls = [];
  const service = createUpstreamDomain(
    context(extract, async (url, options) => {
      calls.push({ url, method: options.method });
      return new Response('', { status: 200, headers: { 'last-modified': 'Fri, 02 Jan 2026 00:00:00 GMT' } });
    })
  );
  assert.equal((await service.getRegionUpstreamState(region(extract))).upstreamStatus, 'update_available');
  assert.deepEqual(calls, [{ url: extract.downloadUrl, method: 'HEAD' }]);
});
