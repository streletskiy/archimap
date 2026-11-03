const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { prepareManagedRegionSource, deriveManagedReplicationBaseUrl, normalizeTrustedReplicationBaseUrl,
  parseReplicationState, pruneRegionSourceCache } = require('../../scripts/region-sync/source-cache');

const extract = { extractSource: 'osmfr', extractId: 'russia/volga_federal_district/nizhny_novgorod_oblast',
  downloadUrl: 'https://download.openstreetmap.fr/extracts/russia/volga_federal_district/nizhny_novgorod_oblast.osm.pbf' };
const baseUrl = deriveManagedReplicationBaseUrl(extract);
const timestamp = sequence => new Date(Date.UTC(2026, 10, 3, 0, sequence)).toISOString();
const stateText = sequence => `sequenceNumber=${sequence}\ntimestamp=${timestamp(sequence).replace(/[\\:]/g, '\\$&')}\n`;

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-source-cache-'));
  const workspace = path.join(dataDir, 'workspace'); fs.mkdirSync(workspace);
  const counters = { full: 0, apply: 0, requests: [], ordered: [] };
  const state = { latest: 10, fullSequence: 10, failSequence: null, invalidGzip: false, invalidState: false };
  const options: LooseRecord = {
    region: { id: 267, ...extract }, dataDir, workspace, importSignature: 'import-v1',
    now: '2026-11-03T01:00:00Z', env: {}, regionCatalog: { findEntry: () => extract },
    fetchImpl: async url => {
      counters.requests.push(String(url));
      if (String(url) === `${baseUrl}state.txt`) return new Response(stateText(state.latest));
      const match = /\/(\d{3})\/(\d{3})\/(\d{3})\.(state\.txt|osc\.gz)$/.exec(String(url));
      assert.ok(match, 'only curated feed paths may be fetched');
      const sequence = Number(match[1] + match[2] + match[3]);
      if (sequence === state.failSequence) return new Response('missing', { status: 404 });
      if (match[4] === 'state.txt') return new Response(stateText(sequence + (state.invalidState ? 1 : 0)));
      return new Response(state.invalidGzip ? Buffer.from('broken') : zlib.gzipSync(
        `<osmChange version="0.6"><modify><way id="1" version="${sequence}"><nd ref="7"/><tag k="building" v="yes"/></way></modify></osmChange>`));
    },
    downloadFull: async ({ workspace }) => {
      counters.full++;
      const pbfPath = path.join(workspace, `full-${counters.full}.osm.pbf`);
      fs.writeFileSync(pbfPath, JSON.stringify({ sequence: state.fullSequence, timestamp: timestamp(state.fullSequence), baseUrl,
        payload: 'complete nodes, ways, relations and every source tag' }));
      return { pbfPath, sourceSnapshot: { sizeBytes: fs.statSync(pbfPath).size, sourceMtime: timestamp(state.fullSequence) } };
    },
    osmiumTools: {
      readPbfReplicationMetadata: async file => JSON.parse(fs.readFileSync(file, 'utf8')),
      applyReplicationChanges: async ({ basePath, changePaths, targetPath, state: target }) => {
        counters.apply++; counters.ordered = changePaths.map(file => Number(path.basename(file).split('.')[0]));
        const original = JSON.parse(fs.readFileSync(basePath, 'utf8'));
        fs.writeFileSync(targetPath, JSON.stringify({ ...original, ...target }));
        return target;
      }
    }
  };
  return { dataDir, workspace, counters, state, options, close: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('replication URLs and state parsing reject mismatched providers and ambiguous cursors', () => {
  assert.equal(normalizeTrustedReplicationBaseUrl(baseUrl.replace('https:', 'http:').replace('/replication/', '/replication/./'), extract), baseUrl);
  assert.equal(normalizeTrustedReplicationBaseUrl('https://127.0.0.1/minute/', extract), null);
  assert.equal(normalizeTrustedReplicationBaseUrl(baseUrl.replace('nizhny_novgorod_oblast/', ''), extract), null);
  assert.equal(normalizeTrustedReplicationBaseUrl(baseUrl + '?token=x', extract), null);
  assert.equal(deriveManagedReplicationBaseUrl({ extractSource: 'geofabrik', downloadUrl: 'https://download.geofabrik.de/europe/germany-latest.osm.pbf' }),
    'https://download.geofabrik.de/europe/germany-updates/');
  assert.deepEqual(parseReplicationState('#comment\n' + stateText(10)), { sequence: 10, timestamp: timestamp(10) });
  for (const text of ['sequenceNumber=-1\ntimestamp=2026-11-03T00:00:00Z', stateText(1) + 'sequenceNumber=2\n',
    'sequenceNumber=9007199254740993\ntimestamp=2026-11-03T00:00:00Z', 'sequenceNumber=1\ntimestamp=bad']) {
    assert.throws(() => parseReplicationState(text));
  }
});

test('bootstrap anchors the PBF header, catches up contiguous diffs, and publishes an immutable complete source', async () => {
  const f = fixture();
  try {
    f.state.latest = 12;
    const result = await prepareManagedRegionSource(f.options);
    assert.equal(result.sourceMode, 'full');
    assert.equal(result.sourceSnapshot.replicationSequence, 12);
    assert.equal(result.sourceSnapshot.replicationTimestamp, timestamp(12));
    assert.equal(result.sourceSnapshot.persistentSource, true);
    assert.equal(result.diffCount, 2);
    assert.deepEqual(f.counters.ordered, [11, 12]);
    assert.equal(f.counters.full, 1);
    assert.ok(result.pbfPath.startsWith(path.join(f.dataDir, 'source-cache', 'r267')));
    const content = fs.readFileSync(result.pbfPath);
    assert.match(content.toString(), /complete nodes, ways, relations and every source tag/);
    assert.equal(result.sourceSnapshot.sha256, crypto.createHash('sha256').update(content).digest('hex'));
    assert.equal(result.sourceSnapshot.localPath, result.pbfPath);
  } finally { f.close(); }
});

test('same cursor avoids source download/import while changed import configuration reuses the verified cache', async () => {
  const f = fixture();
  try {
    const first = await prepareManagedRegionSource(f.options);
    const next = await prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot });
    assert.equal(next.sourceMode, 'unchanged');
    assert.equal(next.downloadRequests, 1);
    assert.equal(next.diffCount, 0);
    assert.equal(f.counters.full, 1);
    assert.equal(f.counters.apply, 0);
    const changed = await prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot, importSignature: 'import-v2' });
    assert.equal(changed.sourceMode, 'cached');
    assert.equal(changed.downloadRequests, 1);
    assert.equal(changed.sourceSnapshot.importSignature, 'import-v2');
    assert.equal(changed.pbfPath, first.pbfPath);
    f.state.latest = 11;
    const freshUpgrade = await prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot, importSignature: 'import-v2' });
    assert.equal(freshUpgrade.sourceMode, 'incremental', 'a code upgrade must still fetch newer source changes');
    assert.equal(freshUpgrade.sourceSnapshot.replicationSequence, 11);
  } finally { f.close(); }
});

test('incremental preparation preserves the committed cache until explicit post-commit pruning', async () => {
  const f = fixture();
  try {
    const first = await prepareManagedRegionSource(f.options);
    const oldBytes = fs.readFileSync(first.pbfPath);
    f.state.latest = 13;
    const next = await prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot });
    assert.equal(next.sourceMode, 'incremental');
    assert.equal(next.diffCount, 3);
    assert.equal(next.downloadRequests, 5, 'one frontier, one final state and one request for each diff');
    assert.deepEqual(f.counters.ordered, [11, 12, 13]);
    assert.equal(f.counters.full, 1);
    assert.deepEqual(fs.readFileSync(first.pbfPath), oldBytes, 'failed DB apply can still restart from the committed source');
    assert.equal(first.sourceSnapshot.replicationSequence, 10);
    fs.writeFileSync(path.join(path.dirname(next.pbfPath), 'user-note.txt'), 'preserve');
    assert.equal(pruneRegionSourceCache({ dataDir: f.dataDir, regionId: 267, activePath: next.pbfPath }), 1);
    assert.equal(fs.existsSync(first.pbfPath), false);
    assert.equal(fs.existsSync(next.pbfPath), true);
    assert.equal(fs.existsSync(path.join(path.dirname(next.pbfPath), 'user-note.txt')), true);
    assert.throws(() => pruneRegionSourceCache({ dataDir: f.dataDir, regionId: 267, activePath: path.join(f.workspace, 'outside.osm.pbf') }));
  } finally { f.close(); }
});

test('missing or corrupt diffs cannot skip a sequence or downgrade a committed source', async () => {
  for (const fault of ['missing', 'gzip', 'state']) {
    const f = fixture();
    try {
      const first = await prepareManagedRegionSource(f.options);
      f.state.latest = 12; f.state.fullSequence = 9;
      if (fault === 'missing') f.state.failSequence = 11;
      if (fault === 'gzip') f.state.invalidGzip = true;
      if (fault === 'state') f.state.invalidState = true;
      await assert.rejects(prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot }));
      assert.equal(JSON.parse(fs.readFileSync(first.pbfPath, 'utf8')).sequence, 10);
      assert.equal(first.sourceSnapshot.replicationSequence, 10);
      assert.equal(f.counters.apply, 0);
    } finally { f.close(); }
  }
});

test('fresh full rebase recovers a missing diff and source corruption without losing the old active pointer', async () => {
  const f = fixture();
  try {
    const first = await prepareManagedRegionSource(f.options);
    f.state.latest = 12; f.state.fullSequence = 12; f.state.failSequence = 11;
    const fallback = await prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot });
    assert.equal(fallback.sourceMode, 'full');
    assert.equal(fallback.sourceSnapshot.replicationSequence, 12);
    assert.equal(fs.existsSync(first.pbfPath), true);
    fs.writeFileSync(fallback.pbfPath, 'corrupt');
    const repaired = await prepareManagedRegionSource({ ...f.options, previousSnapshot: fallback.sourceSnapshot });
    assert.equal(repaired.sourceMode, 'full');
    assert.equal(repaired.pbfPath, fallback.pbfPath);
    assert.equal(JSON.parse(fs.readFileSync(repaired.pbfPath, 'utf8')).sequence, 12);
  } finally { f.close(); }
});

test('catch-up and decompression limits fail safely rather than publishing an older full snapshot', async () => {
  const f = fixture();
  try {
    const first = await prepareManagedRegionSource(f.options);
    f.state.latest = 15; f.state.fullSequence = 9;
    await assert.rejects(prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot,
      env: { REGION_SYNC_MAX_DIFFS: '2' } }), /catch-up limit/);
    f.state.latest = 11;
    await assert.rejects(prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot,
      env: { REGION_SYNC_MAX_DIFF_BYTES: '10' } }), /size limit/);
    assert.equal(JSON.parse(fs.readFileSync(first.pbfPath, 'utf8')).sequence, 10);
  } finally { f.close(); }
});

test('caller cancellation aborts replication requests without starting a full fallback', async () => {
  const f = fixture();
  try {
    const first = await prepareManagedRegionSource(f.options);
    const controller = new AbortController();
    const promise = prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot, signal: controller.signal,
      fetchImpl: async (_url, { signal }) => {
        controller.abort(new Error('cancelled fixture'));
        signal.throwIfAborted();
      } });
    await assert.rejects(promise, /cancelled fixture/);
    assert.equal(f.counters.full, 1);
    assert.equal(fs.existsSync(first.pbfPath), true);
  } finally { f.close(); }
});

test('sources without replication use a GET-bound strong ETag and stream a changed response only once', async () => {
  const f = fixture();
  try {
    f.options.osmiumTools.readPbfReplicationMetadata = async () => null;
    const first = await prepareManagedRegionSource(f.options);
    assert.equal(first.sourceSnapshot.replicationSequence, null);
    let gets = 0;
    const body = JSON.stringify({ payload: 'complete raw source', version: 2 });
    const second = await prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot,
      fetchImpl: async (url, init) => {
        gets++;
        assert.equal(url, extract.downloadUrl);
        assert.deepEqual(init.headers, {});
        return new Response(body, { headers: { etag: '"version-2"', 'last-modified': 'Tue, 03 Nov 2026 01:00:00 GMT' } });
      } });
    assert.equal(gets, 1);
    assert.equal(second.downloadBytes, Buffer.byteLength(body));
    assert.equal(second.downloadRequests, 1);
    assert.equal(second.sourceSnapshot.sourceEtag, '"version-2"');
    assert.equal(fs.readFileSync(second.pbfPath, 'utf8'), body);
    const third = await prepareManagedRegionSource({ ...f.options, previousSnapshot: second.sourceSnapshot,
      fetchImpl: async (url, init) => {
        assert.equal(url, extract.downloadUrl);
        assert.equal(init.headers['if-none-match'], '"version-2"');
        return new Response(null, { status: 304, headers: { etag: '"version-2"' } });
      } });
    assert.equal(third.sourceMode, 'unchanged');
    assert.equal(third.downloadBytes, 0);
    assert.equal(third.pbfPath, second.pbfPath);
    assert.equal(third.sourceSnapshot.persistentSource, true);
    assert.equal(f.counters.full, 1);
  } finally { f.close(); }
});

test('HEAD metadata is never attached to a separately downloaded source as a conditional validator', async () => {
  const f = fixture();
  try {
    const download = f.options.downloadFull;
    f.options.downloadFull = async options => {
      await options.fetchImpl(extract.downloadUrl, { method: 'HEAD' });
      return download(options);
    };
    const originalFetch = f.options.fetchImpl;
    f.options.fetchImpl = async (url, init) => String(init?.method) === 'HEAD'
      ? new Response(null, { headers: { etag: '"different-head-version"', 'last-modified': 'Wed, 04 Nov 2026 00:00:00 GMT' } })
      : originalFetch(url, init);
    const result = await prepareManagedRegionSource(f.options);
    assert.equal(result.sourceSnapshot.sourceEtag, null);
    assert.equal(result.sourceSnapshot.sourceLastModified, null);
    assert.equal(result.sourceSnapshot.sourceMtime, timestamp(10), 'the PBF header is the authoritative source cut');
  } finally { f.close(); }
});

test('a full fallback cannot redefine the timestamp of an already committed replication sequence', async () => {
  const f = fixture();
  try {
    const first = await prepareManagedRegionSource(f.options);
    const oldBytes = fs.readFileSync(first.pbfPath);
    const fullDownload = f.options.downloadFull;
    f.options.downloadFull = async options => {
      const result = await fullDownload(options);
      const value = JSON.parse(fs.readFileSync(result.pbfPath, 'utf8'));
      fs.writeFileSync(result.pbfPath, JSON.stringify({ ...value, timestamp: timestamp(11) }));
      return result;
    };
    f.options.fetchImpl = async () => new Response(`sequenceNumber=10\ntimestamp=${timestamp(11)}\n`);
    await assert.rejects(prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot }), /older snapshot/);
    assert.deepEqual(fs.readFileSync(first.pbfPath), oldBytes);
  } finally { f.close(); }
});

test('explicit proof of no active snapshot permits cleanup of failed bootstrap files only', async () => {
  const f = fixture();
  try {
    const prepared = await prepareManagedRegionSource(f.options);
    const directory = path.dirname(prepared.pbfPath);
    fs.writeFileSync(path.join(directory, 'keep-user-file.txt'), 'preserve');
    assert.throws(() => pruneRegionSourceCache({ dataDir: f.dataDir, regionId: 267, activePath: null }));
    assert.equal(fs.existsSync(prepared.pbfPath), true, 'absence of a caller path is not proof of an absent DB snapshot');
    assert.equal(pruneRegionSourceCache({ dataDir: f.dataDir, regionId: 267, activePath: null, noActiveSnapshot: true }), 1);
    assert.equal(fs.existsSync(prepared.pbfPath), false);
    assert.equal(fs.existsSync(path.join(directory, 'keep-user-file.txt')), true);
    assert.equal(pruneRegionSourceCache({ dataDir: f.dataDir, regionId: 999, activePath: null, noActiveSnapshot: true }), 0);
  } finally { f.close(); }
});

test('the exact target state must match the frontier captured before fetching diffs', async () => {
  const f = fixture();
  try {
    const first = await prepareManagedRegionSource(f.options);
    f.state.latest = 12; f.state.fullSequence = 9;
    const fetch = f.options.fetchImpl;
    f.options.fetchImpl = async url => String(url).endsWith('/000/000/012.state.txt')
      ? new Response(`sequenceNumber=12\ntimestamp=${timestamp(13)}\n`)
      : fetch(url);
    await assert.rejects(prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot }), /captured frontier/);
    assert.equal(f.counters.apply, 0);
    assert.equal(JSON.parse(fs.readFileSync(first.pbfPath, 'utf8')).sequence, 10);
  } finally { f.close(); }
});

test('the default catch-up window covers weekly synchronization while an explicit request remains bounded', async () => {
  const f = fixture();
  try {
    const first = await prepareManagedRegionSource(f.options);
    f.state.latest = 10 + 7 * 24 * 60;
    f.state.fullSequence = 9;
    f.state.invalidGzip = true;
    await assert.rejects(prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot }), /not gzip/);
    assert.ok(f.counters.requests.some(url => url.endsWith('/000/010/090.state.txt')),
      'a weekly gap reaches diff validation instead of forcing a full download by count');
    f.state.latest = 20011;
    await assert.rejects(prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot,
      env: { REGION_SYNC_MAX_DIFFS: '50000' } }), /catch-up limit/);
    assert.equal(first.sourceSnapshot.replicationSequence, 10);
  } finally { f.close(); }
});

test('only wholly inspected strictly empty diff batches prove unchanged building input after native apply', async () => {
  const nodeChange = '<osmChange version="0.6"><modify><node id="7" version="2" lat="56" lon="44"/></modify></osmChange>';
  const cases = [
    { label: 'empty root', documents: ['<osmChange version="0.6">\n </osmChange>'], empty: true },
    { label: 'declaration and self-closing root', documents: ['<?xml version="1.0" encoding="UTF-8"?>\n<osmChange version="0.6" generator="fixture" />'], empty: true },
    { label: 'bare self-closing root', documents: ['<osmChange/>'], empty: true },
    { label: 'node-only movement', documents: [nodeChange], empty: false },
    { label: 'empty comment', documents: ['<osmChange version="0.6"><!-- no objects --></osmChange>'], empty: false },
    { label: 'empty operation', documents: ['<osmChange version="0.6"><modify/></osmChange>'], empty: false },
    { label: 'beyond bounded inspection', documents: [`<osmChange>${' '.repeat(16384)}</osmChange>`], empty: false },
    { label: 'mixed batch', documents: ['<osmChange/>', nodeChange], empty: false }
  ];
  for (const entry of cases) {
    const f = fixture();
    try {
      const first = await prepareManagedRegionSource(f.options);
      const fetch = f.options.fetchImpl;
      f.state.latest = 10 + entry.documents.length;
      f.options.fetchImpl = async url => {
        if (!String(url).endsWith('.osc.gz')) return fetch(url);
        const sequence = Number(String(url).match(/(\d{3})\.osc\.gz$/)[1]);
        return new Response(zlib.gzipSync(entry.documents[sequence - 11]));
      };
      const next = await prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot });
      assert.equal(next.sourceMode, 'incremental', entry.label);
      assert.equal(next.buildingInputUnchanged === true, entry.empty, entry.label);
      assert.equal(f.counters.apply, 1, `${entry.label}: native validation/apply cannot be bypassed`);
      assert.equal(next.sourceSnapshot.replicationSequence, f.state.latest, entry.label);
      assert.notEqual(next.sourceSnapshot.sha256, first.sourceSnapshot.sha256, `${entry.label}: the new cursor belongs to a new immutable PBF`);
      assert.equal(JSON.parse(fs.readFileSync(first.pbfPath, 'utf8')).sequence, 10);
    } finally { f.close(); }
  }
});

test('empty catch-up diffs never prove unchanged building input for bootstrap or full rebasing', async () => {
  const f = fixture();
  try {
    const fetch = f.options.fetchImpl;
    f.options.fetchImpl = async url => String(url).endsWith('.osc.gz')
      ? new Response(zlib.gzipSync('<osmChange version="0.6"/>')) : fetch(url);
    f.state.latest = 11;
    const first = await prepareManagedRegionSource(f.options);
    assert.equal(first.sourceMode, 'full');
    assert.equal(first.buildingInputUnchanged, undefined);
    assert.equal(f.counters.apply, 1);
    f.state.latest = 12;
    const rebase = await prepareManagedRegionSource({ ...f.options, previousSnapshot: first.sourceSnapshot, now: '2026-12-04T01:00:00Z' });
    assert.equal(rebase.sourceMode, 'full');
    assert.equal(rebase.buildingInputUnchanged, undefined);
    assert.equal(rebase.sourceSnapshot.replicationSequence, 12);
    assert.equal(f.counters.apply, 2);
  } finally { f.close(); }
});
