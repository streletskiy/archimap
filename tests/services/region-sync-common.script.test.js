const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  createWorkspace,
  parseRowPayload,
  writeRowsToNdjsonFile
} = require('../../scripts/region-sync/common');
const { summarizeImportRows } = require('../../scripts/region-sync/pmtiles-builder');

test('parseRowPayload accepts WKB-only importer rows for PostgreSQL sync', () => {
  const row = parseRowPayload(JSON.stringify({
    osm_type: 'way',
    osm_id: 123,
    tags_json: '{"building":"yes"}',
    geometry_wkb_hex: '0a0b0c0d',
    min_lon: 37.5,
    min_lat: 55.5,
    max_lon: 37.6,
    max_lat: 55.6
  }), { requireGeometryWkbHex: true });

  assert.equal(row.geometry_json, null);
  assert.equal(row.geometry_wkb_hex, '0A0B0C0D');
});

test('parseRowPayload rejects missing GeoJSON when GeoJSON is required', () => {
  assert.throws(() => parseRowPayload(JSON.stringify({
    osm_type: 'way',
    osm_id: 123,
    geometry_wkb_hex: '0A0B',
    min_lon: 37.5,
    min_lat: 55.5,
    max_lon: 37.6,
    max_lat: 55.6
  }), { requireGeometryJson: true }), /empty GeoJSON geometry/i);
});

test('parseRowPayload rejects invalid WKB when WKB is required', () => {
  assert.throws(() => parseRowPayload(JSON.stringify({
    osm_type: 'relation',
    osm_id: 456,
    geometry_wkb_hex: 'XYZ',
    min_lon: 37.5,
    min_lat: 55.5,
    max_lon: 37.6,
    max_lat: 55.6
  }), { requireGeometryWkbHex: true }), /empty WKB geometry/i);
});

test('summarizeImportRows counts WKB-only import rows and computes bounds', async () => {
  const workspace = createWorkspace(999);
  const importPath = path.join(workspace, 'region-import.ndjson');

  try {
    await writeRowsToNdjsonFile(importPath, [
      {
        osm_type: 'way',
        osm_id: 1,
        geometry_wkb_hex: '0A0B',
        min_lon: 37.5,
        min_lat: 55.5,
        max_lon: 37.6,
        max_lat: 55.6
      },
      {
        osm_type: 'relation',
        osm_id: 2,
        geometry_wkb_hex: '0C0D',
        min_lon: 36.9,
        min_lat: 55.1,
        max_lon: 38.2,
        max_lat: 56.0
      }
    ]);

    const summary = await summarizeImportRows(importPath, { requireGeometryWkbHex: true });

    assert.equal(summary.importedFeatureCount, 2);
    assert.deepEqual(summary.bounds, {
      west: 36.9,
      south: 55.1,
      east: 38.2,
      north: 56.0
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
