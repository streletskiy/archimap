const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildRegionTiles } = require('../../scripts/region-sync/tile-build');
const { buildRegionTileSignature } = require('../../scripts/region-sync/tile-state');

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-tile-build-'));
  const inputBase = path.join(workspace, 'tile-inputs');
  fs.mkdirSync(inputBase);
  const env: Record<string, string> = { REGION_SYNC_TILE_INPUT_DIR: inputBase };
  const archivePath = path.join(workspace, 'old.pmtiles');
  fs.writeFileSync(archivePath, 'previous');
  const region = { id: 1, slug: 'fixture', pmtilesMinZoom: 13, pmtilesMaxZoom: 16 };
  const stat = fs.statSync(archivePath);
  const state = { data_revision: '2', published_revision: '1', full_rebuild_required: false,
    dirty_bounds: [{ west: 44, east: 44.001, south: 56, north: 56.001 }],
    published_signature: buildRegionTileSignature(region), published_archive_bytes: stat.size,
    published_archive_mtime_ms: stat.mtimeMs };
  const calls = [];
  const dependencies: LooseRecord = {
    readState: async () => state,
    exportFeatures: async options => { calls.push(['export', options]); return { importedFeatureCount: 5, bounds: 'subset', regionBounds: 'whole' }; },
    build: async options => { calls.push(['build', options]); return { engine: 'planetiler', mode: 'single' }; },
    patch: async options => { calls.push(['patch', options]); return { retainedTileCount: 100, replacedTileCount: 4 }; },
    publish: async options => { calls.push(['publish', options]); }
  };
  return { workspace, inputBase, archivePath, region, state, calls, dependencies,
    options: { workspace, archivePath, region, runtimeOptions: { databaseUrl: 'fixture' }, dependencies, env } };
}

test('partial builds use complete buffered tile windows and publish against the original base identity', async () => {
  const f = fixture();
  try {
    const result = await buildRegionTiles(f.options);
    assert.equal(result.buildResult.mode, 'incremental');
    assert.equal(result.bounds, 'whole');
    assert.deepEqual(f.calls.map(c => c[0]), ['export', 'build', 'patch', 'publish']);
    assert.ok(f.calls[0][1].tileWindows.length > 0);
    const exportPath = f.calls[0][1].outputPath;
    assert.equal(path.dirname(path.dirname(exportPath)), f.inputBase);
    assert.equal(f.calls[1][1].geojsonPath, exportPath);
    assert.equal(f.calls[1][1].sharedTileInput, true);
    assert.equal(fs.existsSync(path.dirname(exportPath)), false);
    assert.equal(f.calls[3][1].expectedBase, f.state);
    assert.equal(f.calls[2][1].bounds, undefined, 'patch must not shrink global archive bounds');
  } finally { fs.rmSync(f.workspace, { recursive: true, force: true }); }
});

test('empty subset deletes dirty tiles without running Planetiler', async () => {
  const f = fixture();
  try {
    f.dependencies.exportFeatures = async () => ({ importedFeatureCount: 0, regionBounds: null });
    assert.equal((await buildRegionTiles(f.options)).buildResult.mode, 'incremental');
    assert.deepEqual(f.calls.map(c => c[0]), ['patch', 'publish']);
    assert.equal(f.calls[0][1].patchPath, null);
  } finally { fs.rmSync(f.workspace, { recursive: true, force: true }); }
});

test('large dirty histories use one patch and one shared tile budget', async () => {
  const f = fixture();
  try {
    const footprint = f.state.dirty_bounds[0];
    f.state.dirty_bounds = Array.from({ length: 300 }, () => footprint);
    assert.equal((await buildRegionTiles(f.options)).buildResult.mode, 'incremental');
    assert.equal(f.calls.filter(c => c[0] === 'patch').length, 1);
    const tiles = f.calls.find(c => c[0] === 'patch')[1].dirtyTileIds;
    assert.equal(tiles.length, new Set(tiles).size);

    f.calls.length = 0;
    f.state.dirty_bounds = [
      ...Array.from({ length: 255 }, () => footprint),
      { west: 40, south: 30, east: 40.5, north: 30.5 },
      { west: 42, south: 30, east: 42.5, north: 30.5 }
    ];
    const result = await buildRegionTiles(f.options);
    assert.equal(result.buildResult.fullReason, 'dirty tile limit exceeded');
    assert.equal(f.calls[0][1].tileWindows, null);
  } finally { fs.rmSync(f.workspace, { recursive: true, force: true }); }
});

test('unusable patch falls back to a fresh full export, cancellation never starts fallback work', async () => {
  const f = fixture();
  try {
    f.dependencies.patch = async () => { throw new Error('unsupported archive'); };
    assert.equal((await buildRegionTiles(f.options)).buildResult.mode, 'single');
    const exports = f.calls.filter(c => c[0] === 'export');
    assert.ok(exports[0][1].tileWindows.length);
    assert.equal(exports[1][1].tileWindows, null);
    f.calls.length = 0;
    const abort = new AbortController();
    f.dependencies.patch = async () => { abort.abort(new Error('cancelled')); abort.signal.throwIfAborted(); };
    await assert.rejects(buildRegionTiles({ ...f.options, signal: abort.signal }), /cancelled/);
    assert.equal(f.calls.filter(c => c[0] === 'export').length, 1);
    assert.equal(fs.existsSync(path.dirname(f.calls[0][1].outputPath)), false);
    assert.equal(f.calls.filter(c => c[0] === 'publish').length, 0);
  } finally { fs.rmSync(f.workspace, { recursive: true, force: true }); }
});

test('forced rebuild and changed render contract cannot reuse a partial base', async () => {
  const f = fixture();
  try {
    assert.equal((await buildRegionTiles({ ...f.options, forceFull: true })).buildResult.mode, 'single');
    assert.equal(f.calls[0][1].tileWindows, null);
    f.calls.length = 0;
    f.state.published_signature = 'outdated';
    f.options.env.REGION_SYNC_PLANETILER_LOCAL_IO = 'false';
    assert.equal((await buildRegionTiles(f.options)).buildResult.mode, 'single');
    assert.equal(f.calls[0][1].tileWindows, null);
    assert.equal(path.dirname(f.calls[0][1].outputPath), f.workspace);
    assert.equal(f.calls[1][1].sharedTileInput, false);
  } finally { fs.rmSync(f.workspace, { recursive: true, force: true }); }
});
