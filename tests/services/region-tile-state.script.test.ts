const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildRegionTileSignature, canReuseRegionArchive } = require('../../scripts/region-sync/tile-state');
const { buildPmtilesSwap } = require('../../scripts/region-sync/common');

test('tile reuse requires a complete matching published archive and revision', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-tile-state-'));
  const archivePath = path.join(directory, 'region.pmtiles');
  try {
    fs.writeFileSync(archivePath, 'test archive');
    const stat = fs.statSync(archivePath);
    const state = {
      data_revision: '12', published_revision: '12', published_signature: 'current',
      published_archive_bytes: stat.size, published_archive_mtime_ms: stat.mtimeMs
    };
    assert.equal(canReuseRegionArchive({ state, signature: 'current', archivePath }), true);
    assert.equal(canReuseRegionArchive({ state: { ...state, data_revision: '13' }, signature: 'current', archivePath }), false);
    assert.equal(canReuseRegionArchive({ state, signature: 'changed', archivePath }), false);
    assert.equal(canReuseRegionArchive({ state: null, signature: 'current', archivePath }), false);
    fs.writeFileSync(archivePath, 'truncated');
    assert.equal(canReuseRegionArchive({ state, signature: 'current', archivePath }), false);
    fs.unlinkSync(archivePath);
    assert.equal(canReuseRegionArchive({ state, signature: 'current', archivePath }), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('tile signature changes when output configuration changes', () => {
  const region = { slug: 'fixture', sourceLayer: 'buildings', pmtilesMinZoom: 13, pmtilesMaxZoom: 16 };
  const signature = buildRegionTileSignature(region);
  assert.equal(signature, buildRegionTileSignature({ ...region }));
  assert.notEqual(signature, buildRegionTileSignature({ ...region, pmtilesMaxZoom: 15 }));
  assert.notEqual(signature, buildRegionTileSignature({ ...region, sourceLayer: 'different' }));
});

test('failed archive move restores the previously published file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-tile-swap-'));
  const archivePath = path.join(directory, 'region.pmtiles');
  try {
    fs.writeFileSync(archivePath, 'previous');
    assert.throws(() => buildPmtilesSwap(archivePath, path.join(directory, 'missing.pmtiles')));
    assert.equal(fs.readFileSync(archivePath, 'utf8'), 'previous');
    assert.equal(fs.existsSync(`${archivePath}.bak`), false);
    fs.renameSync(archivePath, `${archivePath}.bak`);
    assert.throws(() => buildPmtilesSwap(archivePath, path.join(directory, 'still-missing.pmtiles')));
    assert.equal(fs.readFileSync(archivePath, 'utf8'), 'previous', 'interrupted swap backup remains recoverable');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
