const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isIncrementalEnabled,
  resolveIncrementalNewPbf,
  countNdjsonLines,
  buildSourceSnapshotFromLocalPbf,
  hashFile,
  runIncrementalRegionSync,
  commitIncrementalSuccess
} = require('../../scripts/region-sync/incremental-orchestrator');

const {
  resolveIncrementalCachePaths,
  snapshotExists
} = require('../../scripts/region-sync/incremental-cache');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

test('isIncrementalEnabled honors only the explicit truthy value', () => {
  assert.equal(isIncrementalEnabled({}), false);
  assert.equal(isIncrementalEnabled({ REGION_SYNC_INCREMENTAL: '' }), false);
  assert.equal(isIncrementalEnabled({ REGION_SYNC_INCREMENTAL: 'no' }), false);
  assert.equal(isIncrementalEnabled({ REGION_SYNC_INCREMENTAL: 'false' }), false);
  assert.equal(isIncrementalEnabled({ REGION_SYNC_INCREMENTAL: ' TRUE ' }), true);
  assert.equal(isIncrementalEnabled({ REGION_SYNC_INCREMENTAL: 'true' }), true);
});

test('resolveIncrementalNewPbf returns null or absolute path', () => {
  assert.equal(resolveIncrementalNewPbf({}), null);
  assert.equal(resolveIncrementalNewPbf({ REGION_SYNC_NEW_PBF: '   ' }), null);
  const resolved = resolveIncrementalNewPbf({ REGION_SYNC_NEW_PBF: 'foo/bar.pbf' });
  assert.ok(path.isAbsolute(resolved), 'should resolve to absolute path');
  assert.ok(resolved.endsWith(path.join('foo', 'bar.pbf')));
});

test('countNdjsonLines counts non-empty lines and handles missing file', async () => {
  const tmp = mkTmpDir('count-ndjson');
  try {
    assert.equal(await countNdjsonLines(path.join(tmp, 'missing.ndjson')), 0);
    const p = path.join(tmp, 'x.ndjson');
    fs.writeFileSync(p, '{"a":1}\n\n{"b":2}\n   \n{"c":3}\n');
    assert.equal(await countNdjsonLines(p), 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildSourceSnapshotFromLocalPbf returns canonical fields', () => {
  const tmp = mkTmpDir('snapshot-fields');
  try {
    const pbf = path.join(tmp, 'geofabrik-russia.pbf');
    fs.writeFileSync(pbf, 'not-really-a-pbf-but-ok-for-stat');
    const snap = buildSourceSnapshotFromLocalPbf(pbf, 'abc123');
    assert.equal(snap.sha256, 'abc123');
    assert.equal(snap.extractId, 'geofabrik-russia.pbf');
    assert.equal(snap.extractSource, 'geofabrik');
    assert.equal(snap.localPath, path.resolve(pbf));
    assert.ok(Number.isInteger(snap.sizeBytes) && snap.sizeBytes > 0);
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(snap.sourceMtime));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('hashFile yields deterministic sha256', async () => {
  const tmp = mkTmpDir('hash-file');
  try {
    const p = path.join(tmp, 'data.bin');
    fs.writeFileSync(p, 'archimap');
    const a = await hashFile(p);
    const b = await hashFile(p);
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runIncrementalRegionSync skips when new PBF is missing', async () => {
  const tmp = mkTmpDir('incremental-missing');
  try {
    const result = await runIncrementalRegionSync({
      region: { id: 1, slug: 'r' },
      runtimeOptions: { dataDir: tmp },
      newPbf: path.join(tmp, 'does-not-exist.pbf'),
      workspace: path.join(tmp, 'ws'),
      importerPath: '/dev/null',
      dbGeometryMode: 'wkb_hex'
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_new_pbf');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runIncrementalRegionSync skips when prev snapshot does not exist', async () => {
  const tmp = mkTmpDir('incremental-no-snapshot');
  try {
    const pbf = path.join(tmp, 'new.pbf');
    fs.writeFileSync(pbf, 'pbf');
    const result = await runIncrementalRegionSync({
      region: { id: 1, slug: 'r' },
      runtimeOptions: { dataDir: tmp },
      newPbf: pbf,
      workspace: path.join(tmp, 'ws'),
      importerPath: '/dev/null',
      dbGeometryMode: 'wkb_hex'
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_prev_snapshot');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('commitIncrementalSuccess atomically writes snapshot artifacts', async () => {
  const tmp = mkTmpDir('incremental-commit');
  try {
    const newPbf = path.join(tmp, 'new.pbf');
    const mergedBuild = path.join(tmp, 'region-build.ndjson');
    const mergedImport = path.join(tmp, 'region-import.ndjson');
    fs.writeFileSync(newPbf, 'pbf-bytes');
    fs.writeFileSync(
      mergedBuild,
      '{"type":"Feature","id":2,"properties":{"osm_id":1,"feature_kind":"building"},"geometry":{}}\n'
    );
    fs.writeFileSync(mergedImport, '{"feature_id":"way/1"}\n{"feature_id":"way/2"}\n');

    const region = { id: 42, slug: 'tiny', bounds: { west: 0, south: 0, east: 1, north: 1 } };
    const root = await commitIncrementalSuccess({
      runtimeOptions: { dataDir: tmp },
      region,
      newPbf,
      mergedBuildPath: mergedBuild,
      mergedImportPath: mergedImport
    });

    const paths = resolveIncrementalCachePaths(tmp, region);
    assert.equal(root, paths.root);
    assert.ok(snapshotExists(paths), 'snapshot should exist after commit');
    const meta = JSON.parse(fs.readFileSync(paths.metaJson, 'utf8'));
    assert.match(meta.pbfSha256, /^[a-f0-9]{64}$/);
    assert.equal(meta.regionId, 42);
    assert.equal(meta.regionSlug, 'tiny');
    assert.ok(meta.pbfSize > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
