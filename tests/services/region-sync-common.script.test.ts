const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const {
  createWorkspace,
  formatGeojsonFeatureLine,
  parseRowPayload,
  writeRowsToNdjsonFile
} = require('../../scripts/region-sync/common');
const { exportImportRowsToGeojson, summarizeImportRows } = require('../../scripts/region-sync/pmtiles-builder');
const { exportRegionMembersToGeojsonNdjson } = require('../../scripts/region-sync/region-db');

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
  assert.equal(row.feature_kind, 'building');
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

test('formatGeojsonFeatureLine preserves geometry json and encoded OSM feature id', () => {
  const line = formatGeojsonFeatureLine('relation', 123, '{"type":"Point","coordinates":[37.6,55.7]}');

  assert.equal(
    line,
    '{"type":"Feature","id":247,"properties":{"osm_id":123,"feature_kind":"building"},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
  );
});

test('formatGeojsonFeatureLine derives building_part feature kind from tags json', () => {
  const line = formatGeojsonFeatureLine(
    'way',
    124,
    '{"type":"Point","coordinates":[37.6,55.7]}',
    '{"building:part":"yes"}'
  );

  assert.equal(
    line,
    '{"type":"Feature","id":248,"properties":{"osm_id":124,"feature_kind":"building_part"},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
  );
});

test('formatGeojsonFeatureLine treats mixed building tags as building', () => {
  const line = formatGeojsonFeatureLine(
    'way',
    125,
    '{"type":"Point","coordinates":[37.6,55.7]}',
    '{"building":"yes","building:part":"yes"}'
  );

  assert.equal(
    line,
    '{"type":"Feature","id":250,"properties":{"osm_id":125,"feature_kind":"building"},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
  );
});

test('parseRowPayload derives building_part feature kind from tags json', () => {
  const row = parseRowPayload(JSON.stringify({
    osm_type: 'relation',
    osm_id: 456,
    tags_json: '{"building:part":"yes"}',
    geometry_json: '{"type":"Point","coordinates":[37.6,55.7]}',
    min_lon: 37.5,
    min_lat: 55.5,
    max_lon: 37.6,
    max_lat: 55.6
  }), { requireGeometryJson: true });

  assert.equal(row.feature_kind, 'building_part');
});

test('parseRowPayload treats mixed building tags as building', () => {
  const row = parseRowPayload(JSON.stringify({
    osm_type: 'way',
    osm_id: 457,
    tags_json: '{"building":"yes","building:part":"yes"}',
    geometry_json: '{"type":"Point","coordinates":[37.6,55.7]}',
    min_lon: 37.5,
    min_lat: 55.5,
    max_lon: 37.6,
    max_lat: 55.6
  }), { requireGeometryJson: true });

  assert.equal(row.feature_kind, 'building');
});

test('exportImportRowsToGeojson writes feature NDJSON and computes bounds', async () => {
  const workspace = createWorkspace(1001);
  const importPath = path.join(workspace, 'region-import.ndjson');
  const geojsonPath = path.join(workspace, 'region-build.ndjson');

  try {
    await writeRowsToNdjsonFile(importPath, [
      {
        osm_type: 'way',
        osm_id: 10,
        geometry_json: '{"type":"Point","coordinates":[37.61,55.75]}',
        min_lon: 37.61,
        min_lat: 55.75,
        max_lon: 37.61,
        max_lat: 55.75
      },
      {
        osm_type: 'relation',
        osm_id: 11,
        geometry_json: '{"type":"Point","coordinates":[38.2,56.0]}',
        min_lon: 38.2,
        min_lat: 56.0,
        max_lon: 38.2,
        max_lat: 56.0
      }
    ]);

    const summary = await exportImportRowsToGeojson(importPath, geojsonPath);
    const lines = fs.readFileSync(geojsonPath, 'utf8').trim().split('\n');

    assert.equal(summary.importedFeatureCount, 2);
    assert.deepEqual(summary.bounds, {
      west: 37.61,
      south: 55.75,
      east: 38.2,
      north: 56.0
    });
    assert.deepEqual(lines, [
      formatGeojsonFeatureLine('way', 10, '{"type":"Point","coordinates":[37.61,55.75]}').trim(),
      formatGeojsonFeatureLine('relation', 11, '{"type":"Point","coordinates":[38.2,56.0]}').trim()
    ]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('exportRegionMembersToGeojsonNdjson streams sqlite region members directly to feature NDJSON', async () => {
  const workspace = createWorkspace(1002);
  const archimapDbPath = path.join(workspace, 'archimap.db');
  const osmDbPath = path.join(workspace, 'osm.db');
  const outputPath = path.join(workspace, 'region-build.ndjson');

  try {
    const archimapDb = new Database(archimapDbPath);
    archimapDb.exec(`
      CREATE TABLE data_region_memberships (
        region_id INTEGER NOT NULL,
        osm_type TEXT NOT NULL,
        osm_id INTEGER NOT NULL
      );
      INSERT INTO data_region_memberships (region_id, osm_type, osm_id)
      VALUES
        (7, 'way', 21),
        (7, 'relation', 22),
        (8, 'way', 99);
    `);
    archimapDb.close();

    const osmDb = new Database(osmDbPath);
    osmDb.exec(`
      CREATE TABLE building_contours (
        osm_type TEXT NOT NULL,
        osm_id INTEGER NOT NULL,
        tags_json TEXT,
        geometry_json TEXT NOT NULL,
        min_lon REAL NOT NULL,
        min_lat REAL NOT NULL,
        max_lon REAL NOT NULL,
        max_lat REAL NOT NULL
      );
      INSERT INTO building_contours (osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat)
      VALUES
        ('way', 21, '{"building":"yes"}', '{"type":"Point","coordinates":[30.0,60.0]}', 30.0, 60.0, 30.0, 60.0),
        ('relation', 22, '{"building":"yes"}', '{"type":"Point","coordinates":[31.5,61.2]}', 31.5, 61.2, 31.5, 61.2),
        ('way', 99, '{"building":"yes"}', '{"type":"Point","coordinates":[99.0,99.0]}', 99.0, 99.0, 99.0, 99.0);
    `);
    osmDb.close();

    const summary = await exportRegionMembersToGeojsonNdjson({
      dbProvider: 'sqlite',
      archimapDbPath,
      osmDbPath,
      regionId: 7,
      outputPath
    });
    const lines = fs.readFileSync(outputPath, 'utf8').trim().split('\n');

    assert.equal(summary.importedFeatureCount, 2);
    assert.deepEqual(summary.bounds, {
      west: 30.0,
      south: 60.0,
      east: 31.5,
      north: 61.2
    });
    assert.deepEqual(lines, [
      formatGeojsonFeatureLine('relation', 22, '{"type":"Point","coordinates":[31.5,61.2]}').trim(),
      formatGeojsonFeatureLine('way', 21, '{"type":"Point","coordinates":[30.0,60.0]}').trim()
    ]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
