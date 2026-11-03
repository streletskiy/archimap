const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildTilePatchPlan, zxyToTileId } = require('../../scripts/region-sync/tile-patch-plan');
const official = require(require.resolve('pmtiles', { paths: [path.resolve(__dirname, '../../frontend')] }));

test('Hilbert IDs match the official PMTiles reader across the supported coordinate range', () => {
  for (let z = 0; z <= 26; z++) {
    const n = 2 ** z;
    for (const x of [0, Math.floor(n / 3), n - 1]) for (const y of [0, Math.floor(n / 2), n - 1]) {
      assert.equal(zxyToTileId(z, x, y), official.zxyToTileId(z, x, y));
    }
  }
  assert.throws(() => zxyToTileId(27, 0, 0));
  assert.throws(() => zxyToTileId(13, -1, 0));
});

test('tile boundaries invalidate both sides and input windows include every buffered dirty tile', () => {
  const plan = buildTilePatchPlan({ dirtyBounds: [{ west: 0, east: 0, south: 0, north: 0 }] });
  assert.equal(plan.mode, 'incremental');
  assert.equal(plan.dirtyTileIds.length, 16);
  for (let z = 13; z <= 16; z++) {
    const n = 2 ** z;
    for (const x of [n / 2 - 1, n / 2]) for (const y of [n / 2 - 1, n / 2]) {
      assert.ok(plan.dirtyTileIds.includes(zxyToTileId(z, x, y)));
      const west = (x - 8 / 256) / n * 360 - 180;
      const east = (x + 1 + 8 / 256) / n * 360 - 180;
      const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y - 8 / 256) / n))) * 180 / Math.PI;
      const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1 + 8 / 256) / n))) * 180 / Math.PI;
      assert.ok(plan.tileWindows.some(w => w.west <= west && w.east >= east && w.south <= south && w.north >= north));
    }
  }
});

test('distant moves stay disjoint, duplicate changes deduplicate, broad or unknown changes rebuild fully', () => {
  const first = { west: 44, east: 44.001, south: 56, north: 56.001 };
  const second = { ...first, west: 45, east: 45.001 };
  const one = buildTilePatchPlan({ dirtyBounds: [first] });
  assert.deepEqual(buildTilePatchPlan({ dirtyBounds: [first, first] }), one);
  const moved = buildTilePatchPlan({ dirtyBounds: [first, second] });
  assert.equal(moved.mode, 'incremental');
  assert.ok(moved.tileWindows.every(w => w.east - w.west < 0.1));
  for (const dirtyBounds of [[], null, [{ ...first, west: -180 }], [{ ...first, north: 90 }],
    [{ west: 0, south: 0, east: 100, north: 70 }]]) assert.equal(buildTilePatchPlan({ dirtyBounds }).mode, 'full');
  assert.equal(buildTilePatchPlan({ dirtyBounds: [first], maxDirtyTiles: 1 }).mode, 'full');
  for (const west of [-179.99999, 179.99998]) {
    assert.equal(buildTilePatchPlan({ dirtyBounds: [{ ...first, west, east: west + 0.000001 }] }).mode, 'full');
  }
});
