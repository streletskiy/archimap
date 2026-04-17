const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  mergeBuildNdjson,
  parseNdjsonLineKey,
  normalizeDeletedObjectKeys,
  decodeEncodedFeatureId,
  compareFeatureKeys
} = require('../../scripts/region-sync/ndjson-merge');

const {
  looksLikeBuilding,
  parseChangeset,
  selectBuildingChanges,
  writeOsmIdFilterFile
} = require('../../scripts/region-sync/osmium-diff');

const {
  parseBboxFromNdjson,
  pointInBbox
} = require('../../scripts/region-sync/spatial-expansion');

const {
  safeRegionKey,
  resolveIncrementalCachePaths,
  snapshotExists
} = require('../../scripts/region-sync/incremental-cache');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function featureLine(osmId, osmType, featureKind, coords) {
  // Encode id the same way the Python importer does.
  const typeBit = osmType === 'relation' ? 1 : 0;
  const encoded = osmId * 2 + typeBit;
  return `${JSON.stringify({
    type: 'Feature',
    id: encoded,
    properties: { osm_id: osmId, feature_kind: featureKind },
    geometry: { type: 'Polygon', coordinates: coords }
  })}\n`;
}

// ---------- ndjson-merge ----------

test('decodeEncodedFeatureId round-trip for ways and relations', () => {
  assert.deepEqual(decodeEncodedFeatureId(10), { osmType: 'way', osmId: 5 });
  assert.deepEqual(decodeEncodedFeatureId(11), { osmType: 'relation', osmId: 5 });
  assert.deepEqual(decodeEncodedFeatureId(0), { osmType: 'way', osmId: 0 });
});

test('parseNdjsonLineKey extracts object + feature keys', () => {
  const line = featureLine(42, 'way', 'building', [[[0, 0], [1, 0], [1, 1], [0, 0]]]);
  const parsed = parseNdjsonLineKey(line);
  assert.equal(parsed.osmType, 'way');
  assert.equal(parsed.osmId, 42);
  assert.equal(parsed.featureKind, 'building');
  assert.equal(parsed.objectKey, 'way/42');
  assert.equal(parsed.featureKey, 'way/42/building');
});

test('parseNdjsonLineKey returns null for non-feature rows', () => {
  assert.equal(parseNdjsonLineKey(''), null);
  assert.equal(parseNdjsonLineKey('not-json'), null);
  assert.equal(parseNdjsonLineKey('{"no":"id"}'), null);
});

test('compareFeatureKeys orders by (osm_type, osm_id, feature_kind)', () => {
  const a = { osmType: 'way', osmId: 1, featureKind: 'building' };
  const b = { osmType: 'way', osmId: 2, featureKind: 'building' };
  const c = { osmType: 'relation', osmId: 1, featureKind: 'building' };
  const d = { osmType: 'way', osmId: 1, featureKind: 'building_remainder' };
  assert.ok(compareFeatureKeys(a, b) < 0);
  assert.ok(compareFeatureKeys(a, c) > 0);
  assert.ok(compareFeatureKeys(a, d) < 0);
  assert.equal(compareFeatureKeys(a, { ...a }), 0);
});

test('normalizeDeletedObjectKeys accepts bare and feature-kind forms', () => {
  const set = normalizeDeletedObjectKeys([
    'way/1',
    'way/2/building',
    'relation/3/building_remainder',
    '',
    'garbage',
    'way/notanumber'
  ]);
  assert.ok(set.has('way/1'));
  assert.ok(set.has('way/2'));
  assert.ok(set.has('relation/3'));
  assert.equal(set.size, 3);
});

test('mergeBuildNdjson: delta shadows prev, deleted rows drop out, order is stable', async () => {
  const tmp = mkTmpDir('ndjson-merge');
  try {
    const prev = path.join(tmp, 'prev.ndjson');
    const delta = path.join(tmp, 'delta.ndjson');
    const out = path.join(tmp, 'out.ndjson');

    const square = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]];
    fs.writeFileSync(
      prev,
      [
        featureLine(1, 'way', 'building', square),
        featureLine(2, 'way', 'building', square),
        featureLine(3, 'way', 'building', square),
        featureLine(10, 'relation', 'building', square)
      ].join('')
    );
    const movedSquare = [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]];
    fs.writeFileSync(
      delta,
      [
        featureLine(2, 'way', 'building', movedSquare), // replace
        featureLine(99, 'way', 'building', movedSquare) // add
      ].join('')
    );

    const stats = await mergeBuildNdjson({
      previousPath: prev,
      deltaPath: delta,
      deletedFeatureIds: ['way/3'],
      outputPath: out
    });

    assert.equal(stats.keptFromPrev, 2);
    assert.equal(stats.replacedByDelta, 1);
    assert.equal(stats.addedFromDelta, 1);
    assert.equal(stats.deletedFromPrev, 1);
    assert.equal(stats.total, 4);

    const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
    const keys = lines.map((line) => parseNdjsonLineKey(line).featureKey);
    // Sort invariant: relations come after ways (r > w), ways sorted by osm_id.
    assert.deepEqual(keys, [
      'relation/10/building',
      'way/1/building',
      'way/2/building',
      'way/99/building'
    ]);
    // way/3 gone, way/2 replaced by delta's moved square.
    const way2 = lines.find((line) => parseNdjsonLineKey(line).objectKey === 'way/2');
    assert.ok(way2.includes('[5,5]'), 'way/2 should carry delta coords');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- osmium-diff ----------

test('looksLikeBuilding: accepts tag values, rejects no/false/empty', () => {
  assert.equal(looksLikeBuilding({ building: 'yes' }), true);
  assert.equal(looksLikeBuilding({ building: 'residential' }), true);
  assert.equal(looksLikeBuilding({ 'building:part': 'yes' }), true);
  assert.equal(looksLikeBuilding({ building: 'no' }), false);
  assert.equal(looksLikeBuilding({ building: 'false' }), false);
  assert.equal(looksLikeBuilding({ building: '' }), false);
  assert.equal(looksLikeBuilding({ highway: 'residential' }), false);
  assert.equal(looksLikeBuilding({}), false);
  assert.equal(looksLikeBuilding(null), false);
});

test('parseChangeset: reads create/modify/delete with nested tags and nd refs', async () => {
  const tmp = mkTmpDir('osmium-diff');
  try {
    const oscPath = path.join(tmp, 'changes.osc');
    // Hand-crafted OSC that matches the shape `osmium derive-changes` emits.
    fs.writeFileSync(
      oscPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<osmChange version="0.6" generator="test">',
        '  <modify>',
        '    <way id="100" version="4">',
        '      <nd ref="1001"/>',
        '      <nd ref="1002"/>',
        '      <tag k="building" v="yes"/>',
        '      <tag k="name" v="Old"/>',
        '    </way>',
        '  </modify>',
        '  <delete>',
        '    <way id="200" version="2">',
        '      <tag k="building" v="residential"/>',
        '    </way>',
        '  </delete>',
        '  <create>',
        '    <node id="5000" version="1" lat="55.12" lon="37.45"/>',
        '  </create>',
        '  <modify>',
        '    <relation id="900" version="3">',
        '      <tag k="type" v="multipolygon"/>',
        '      <tag k="building" v="yes"/>',
        '    </relation>',
        '  </modify>',
        '</osmChange>',
        ''
      ].join('\n')
    );

    const summary = await parseChangeset(oscPath);
    assert.equal(summary.ways.length, 2);
    assert.equal(summary.relations.length, 1);
    assert.equal(summary.nodes.length, 1);

    const modifyWay = summary.ways.find((w) => w.osmId === 100);
    assert.equal(modifyWay.action, 'modify');
    assert.deepEqual(modifyWay.nodeRefs, [1001, 1002]);
    assert.equal(modifyWay.tags.building, 'yes');
    assert.equal(modifyWay.tags.name, 'Old');

    const deletedWay = summary.ways.find((w) => w.osmId === 200);
    assert.equal(deletedWay.action, 'delete');
    assert.equal(deletedWay.tags.building, 'residential');

    const node = summary.nodes[0];
    assert.equal(node.action, 'create');
    assert.equal(node.osmId, 5000);
    assert.equal(node.lat, 55.12);
    assert.equal(node.lon, 37.45);

    const selection = selectBuildingChanges(summary);
    assert.ok(selection.directlyAffected.has('way/100'));
    assert.ok(selection.directlyAffected.has('way/200'));
    assert.ok(selection.directlyAffected.has('relation/900'));
    assert.ok(selection.deletedBuildingFeatureIds.has('way/200'));
    assert.ok(!selection.deletedBuildingFeatureIds.has('way/100'));
    assert.ok(selection.touchedNodeIds.has(5000));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeOsmIdFilterFile sorts and rejects garbage ids', async () => {
  const tmp = mkTmpDir('osmium-diff-filter');
  try {
    const out = path.join(tmp, 'ids.txt');
    await writeOsmIdFilterFile(out, [
      'way/42',
      'relation/10',
      'way/7',
      'node/1',
      '   ',
      'garbage',
      'way/notanumber'
    ]);
    const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
    assert.deepEqual(lines, ['relation/10', 'way/7', 'way/42']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- spatial-expansion ----------

test('parseBboxFromNdjson: returns min/max for a polygon', () => {
  const line = featureLine(1, 'way', 'building', [[[0, 0], [1, 0], [1, 2], [0, 2], [0, 0]]]);
  const bbox = parseBboxFromNdjson(line.trim());
  assert.deepEqual(bbox, { minLon: 0, minLat: 0, maxLon: 1, maxLat: 2 });
});

test('parseBboxFromNdjson: walks multipolygon coordinates', () => {
  const line = `${JSON.stringify({
    type: 'Feature',
    id: 0,
    properties: { osm_id: 1, feature_kind: 'building' },
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [[[-1, -1], [0, -1], [0, 0], [-1, 0], [-1, -1]]],
        [[[3, 3], [4, 3], [4, 5], [3, 5], [3, 3]]]
      ]
    }
  })}`;
  const bbox = parseBboxFromNdjson(line);
  assert.deepEqual(bbox, { minLon: -1, minLat: -1, maxLon: 4, maxLat: 5 });
});

test('pointInBbox handles inside, edge, outside', () => {
  const bbox = { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 };
  assert.equal(pointInBbox(0.5, 0.5, bbox), true);
  assert.equal(pointInBbox(0, 0, bbox), true); // inclusive edge
  assert.equal(pointInBbox(1, 1, bbox), true);
  assert.equal(pointInBbox(-0.01, 0.5, bbox), false);
  assert.equal(pointInBbox(0.5, 1.01, bbox), false);
});

// ---------- incremental-cache ----------

test('safeRegionKey strips unsafe characters and falls back on blanks', () => {
  assert.equal(safeRegionKey({ id: 196, slug: 'kaluga-oblast' }), '196-kaluga-oblast');
  assert.equal(safeRegionKey({ id: 1, slug: 'с пробелами/и слешем' }), '1--');
  assert.equal(safeRegionKey({}), 'unknown-region');
});

test('resolveIncrementalCachePaths composes under <dataDir>/regions/.incremental-cache/<key>', () => {
  const paths = resolveIncrementalCachePaths('/srv/data', { id: 42, slug: 'foo' });
  assert.ok(paths.root.endsWith(path.join('regions', '.incremental-cache', '42-foo')));
  assert.equal(path.basename(paths.prevPbf), 'prev.pbf');
  assert.equal(path.basename(paths.prevBuildNdjson), 'prev-build.ndjson');
  assert.equal(path.basename(paths.metaJson), 'meta.json');
});

test('snapshotExists flips once the required files are present', () => {
  const tmp = mkTmpDir('incremental-cache');
  try {
    const paths = resolveIncrementalCachePaths(tmp, { id: 1, slug: 'a' });
    fs.mkdirSync(paths.root, { recursive: true });
    assert.equal(snapshotExists(paths), false);
    fs.writeFileSync(paths.prevPbf, 'pbf');
    fs.writeFileSync(paths.prevBuildNdjson, 'ndjson');
    assert.equal(snapshotExists(paths), false); // still no meta
    fs.writeFileSync(paths.metaJson, JSON.stringify({ pbfSha256: 'abc' }));
    assert.equal(snapshotExists(paths), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
