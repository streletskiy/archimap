const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildFeature3dPropertiesFromTagsJson,
  cleanupStaleWorkspaces,
  createWorkspace,
  formatGeojsonFeatureLine,
  formatRenderedGeojsonFeatureLine,
  isRegionWorkspacePath,
  parseRowPayload,
  removeWorkspace,
  resolveWorkspaceBaseDir,
  writeRowsToNdjsonFile
} = require('../../scripts/region-sync/common');
const {
  buildPmtilesFromGeojson,
  computeGeometryBounds,
  exportImportRowsToGeojson,
  summarizeImportRows
} = require('../../scripts/region-sync/pmtiles-builder');

test('workspace cleanup only removes stale managed region workspaces', () => {
  const previousDataDir = process.env.ARCHIMAP_DATA_DIR;
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-workspace-cleanup-'));
  process.env.ARCHIMAP_DATA_DIR = tempDataDir;

  try {
    const baseDir = resolveWorkspaceBaseDir();
    const nowMs = Date.UTC(2026, 0, 2, 12, 0, 0);
    const oldDate = new Date(nowMs - 2 * 60 * 60 * 1000);
    const staleWorkspace = path.join(baseDir, 'archimap-region-2-stale');
    const freshWorkspace = path.join(baseDir, 'archimap-region-3-fresh');
    const unrelatedDir = path.join(baseDir, 'manual-cache');

    fs.mkdirSync(staleWorkspace, { recursive: true });
    fs.writeFileSync(path.join(staleWorkspace, 'source.osm.pbf'), 'pbf');
    fs.utimesSync(staleWorkspace, oldDate, oldDate);
    fs.mkdirSync(freshWorkspace, { recursive: true });
    fs.mkdirSync(unrelatedDir, { recursive: true });

    const summary = cleanupStaleWorkspaces({
      nowMs,
      staleMs: 60 * 60 * 1000,
      isPidAliveRef: () => false
    });

    assert.equal(summary.removed, 1);
    assert.equal(fs.existsSync(staleWorkspace), false);
    assert.equal(fs.existsSync(freshWorkspace), true);
    assert.equal(fs.existsSync(unrelatedDir), true);
    assert.equal(isRegionWorkspacePath(freshWorkspace), true);
    assert.equal(isRegionWorkspacePath(unrelatedDir), false);
  } finally {
    if (previousDataDir == null) {
      delete process.env.ARCHIMAP_DATA_DIR;
    } else {
      process.env.ARCHIMAP_DATA_DIR = previousDataDir;
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});

test('workspace cleanup keeps stale workspaces owned by a live marker pid', () => {
  const previousDataDir = process.env.ARCHIMAP_DATA_DIR;
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-workspace-marker-'));
  process.env.ARCHIMAP_DATA_DIR = tempDataDir;

  try {
    const nowMs = Date.UTC(2026, 0, 2, 12, 0, 0);
    const oldDate = new Date(nowMs - 2 * 60 * 60 * 1000);
    const workspace = createWorkspace(4, { log: null });
    fs.utimesSync(workspace, oldDate, oldDate);

    const skipped = cleanupStaleWorkspaces({
      nowMs,
      staleMs: 60 * 60 * 1000,
      isPidAliveRef: () => true
    });
    assert.equal(skipped.removed, 0);
    assert.equal(fs.existsSync(workspace), true);

    const removed = cleanupStaleWorkspaces({
      nowMs,
      staleMs: 60 * 60 * 1000,
      isPidAliveRef: () => false
    });
    assert.equal(removed.removed, 1);
    assert.equal(fs.existsSync(workspace), false);
  } finally {
    if (previousDataDir == null) {
      delete process.env.ARCHIMAP_DATA_DIR;
    } else {
      process.env.ARCHIMAP_DATA_DIR = previousDataDir;
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});

test('removeWorkspace rejects paths outside the managed workspace root', () => {
  const previousDataDir = process.env.ARCHIMAP_DATA_DIR;
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-workspace-guard-'));
  process.env.ARCHIMAP_DATA_DIR = tempDataDir;

  try {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-region-8-outside-'));
    try {
      assert.throws(() => removeWorkspace(outside), /Refusing to remove non-region workspace/);
      assert.equal(fs.existsSync(outside), true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    if (previousDataDir == null) {
      delete process.env.ARCHIMAP_DATA_DIR;
    } else {
      process.env.ARCHIMAP_DATA_DIR = previousDataDir;
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});

test('parseRowPayload accepts WKB-only importer rows for PostgreSQL sync', () => {
  const row = parseRowPayload(
    JSON.stringify({
      osm_type: 'way',
      osm_id: 123,
      tags_json: '{"building":"yes"}',
      geometry_wkb_hex: '0a0b0c0d',
      min_lon: 37.5,
      min_lat: 55.5,
      max_lon: 37.6,
      max_lat: 55.6
    }),
    { requireGeometryWkbHex: true }
  );

  assert.equal(row.geometry_json, null);
  assert.equal(row.geometry_wkb_hex, '0A0B0C0D');
  assert.equal(row.feature_kind, 'building');
});

test('parseRowPayload rejects missing GeoJSON when GeoJSON is required', () => {
  assert.throws(
    () =>
      parseRowPayload(
        JSON.stringify({
          osm_type: 'way',
          osm_id: 123,
          geometry_wkb_hex: '0A0B',
          min_lon: 37.5,
          min_lat: 55.5,
          max_lon: 37.6,
          max_lat: 55.6
        }),
        { requireGeometryJson: true }
      ),
    /empty GeoJSON geometry/i
  );
});

test('parseRowPayload rejects invalid WKB when WKB is required', () => {
  assert.throws(
    () =>
      parseRowPayload(
        JSON.stringify({
          osm_type: 'relation',
          osm_id: 456,
          geometry_wkb_hex: 'XYZ',
          min_lon: 37.5,
          min_lat: 55.5,
          max_lon: 37.6,
          max_lat: 55.6
        }),
        { requireGeometryWkbHex: true }
      ),
    /empty WKB geometry/i
  );
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

test('summarizeImportRows handles import rows larger than the stream chunk size', async () => {
  const workspace = createWorkspace(998);
  const importPath = path.join(workspace, 'region-import.ndjson');

  try {
    await writeRowsToNdjsonFile(importPath, [
      {
        osm_type: 'way',
        osm_id: 3,
        tags_json: JSON.stringify({
          building: 'yes',
          notes: 'x'.repeat(1_200_000)
        }),
        geometry_wkb_hex: '0A0B',
        min_lon: 37.5,
        min_lat: 55.5,
        max_lon: 37.6,
        max_lat: 55.6
      }
    ]);

    const summary = await summarizeImportRows(importPath, { requireGeometryWkbHex: true });

    assert.equal(summary.importedFeatureCount, 1);
    assert.deepEqual(summary.bounds, {
      west: 37.5,
      south: 55.5,
      east: 37.6,
      north: 55.6
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('formatGeojsonFeatureLine preserves geometry json and encoded OSM feature id', () => {
  const line = formatGeojsonFeatureLine('relation', 123, '{"type":"Point","coordinates":[37.6,55.7]}');

  assert.equal(
    line,
    '{"type":"Feature","id":247,"properties":{"osm_type":"relation","osm_key":"relation/123","osm_id":123,"feature_kind":"building","render_height_m":3.2,"render_min_height_m":0,"render_hide_base_when_parts":0},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
  );
});

test('formatGeojsonFeatureLine derives building_part feature kind from tags json', () => {
  const line = formatGeojsonFeatureLine(
    'way',
    124,
    '{"type":"Point","coordinates":[37.6,55.7]}',
    '{"building:part":"apartments"}'
  );

  assert.equal(
    line,
    '{"type":"Feature","id":248,"properties":{"osm_type":"way","osm_key":"way/124","osm_id":124,"feature_kind":"building_part","render_height_m":3.2,"render_min_height_m":0,"render_hide_base_when_parts":0},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
  );
});

test('formatGeojsonFeatureLine treats mixed building tags as building', () => {
  const line = formatGeojsonFeatureLine(
    'way',
    125,
    '{"type":"Point","coordinates":[37.6,55.7]}',
    '{"building":"yes","building:part":"apartments"}'
  );

  assert.equal(
    line,
    '{"type":"Feature","id":250,"properties":{"osm_type":"way","osm_key":"way/125","osm_id":125,"feature_kind":"building","render_height_m":3.2,"render_min_height_m":0,"render_hide_base_when_parts":0},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
  );
});

test('formatGeojsonFeatureLine preserves the hide-base-when-parts render flag', () => {
  const line = formatGeojsonFeatureLine(
    'relation',
    126,
    '{"type":"Point","coordinates":[37.6,55.7]}',
    '{"building":"yes"}',
    'building',
    1
  );

  assert.equal(
    line,
    '{"type":"Feature","id":253,"properties":{"osm_type":"relation","osm_key":"relation/126","osm_id":126,"feature_kind":"building","render_height_m":3.2,"render_min_height_m":0,"render_hide_base_when_parts":1},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
  );
});

test('formatGeojsonFeatureLine preserves building_remainder feature kind', () => {
  const line = formatGeojsonFeatureLine(
    'way',
    127,
    '{"type":"Point","coordinates":[37.6,55.7]}',
    '{"building":"yes"}',
    'building_remainder'
  );

  assert.equal(
    line,
    '{"type":"Feature","id":254,"properties":{"osm_type":"way","osm_key":"way/127","osm_id":127,"feature_kind":"building_remainder","render_height_m":3.2,"render_min_height_m":0,"render_hide_base_when_parts":0},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
  );
});

test('formatRenderedGeojsonFeatureLine preserves stable osm_key properties', () => {
  const line = formatRenderedGeojsonFeatureLine(
    'relation',
    321,
    '{"type":"Point","coordinates":[37.6,55.7]}',
    'building_part',
    12.5,
    3.5,
    1
  );

  assert.equal(
    line,
    '{"type":"Feature","id":643,"properties":{"osm_type":"relation","osm_key":"relation/321","osm_id":321,"feature_kind":"building_part","render_height_m":12.5,"render_min_height_m":3.5,"render_hide_base_when_parts":1},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
  );
});

test('buildFeature3dPropertiesFromTagsJson derives top and base height from levels and min height tags', () => {
  const properties = buildFeature3dPropertiesFromTagsJson('{"building:levels":"5","min_level":"2","min_height":"5.5"}');

  assert.deepEqual(properties, {
    render_height_m: 22.4,
    render_min_height_m: 6.4
  });
});

test('buildFeature3dPropertiesFromTagsJson falls back to one level when levels are missing', () => {
  const properties = buildFeature3dPropertiesFromTagsJson('{"building":"yes"}');

  assert.deepEqual(properties, {
    render_height_m: 3.2,
    render_min_height_m: 0
  });
});

test('buildFeature3dPropertiesFromTagsJson uses explicit height when present', () => {
  const properties = buildFeature3dPropertiesFromTagsJson(
    '{"building:levels":"4","building:height":"18.5","min_height":"5.5"}'
  );

  assert.deepEqual(properties, {
    render_height_m: 18.5,
    render_min_height_m: 5.5
  });
});

test('buildFeature3dPropertiesFromTagsJson ignores explicit height below the base offset', () => {
  const properties = buildFeature3dPropertiesFromTagsJson('{"height":"4","min_height":"5.5"}');

  assert.deepEqual(properties, {
    render_height_m: 8.7,
    render_min_height_m: 5.5
  });
});

test('parseRowPayload derives building_part feature kind from tags json', () => {
  const row = parseRowPayload(
    JSON.stringify({
      osm_type: 'relation',
      osm_id: 456,
      tags_json: '{"building:part":"apartments"}',
      geometry_json: '{"type":"Point","coordinates":[37.6,55.7]}',
      min_lon: 37.5,
      min_lat: 55.5,
      max_lon: 37.6,
      max_lat: 55.6
    }),
    { requireGeometryJson: true }
  );

  assert.equal(row.feature_kind, 'building_part');
});

test('parseRowPayload treats mixed building tags as building', () => {
  const row = parseRowPayload(
    JSON.stringify({
      osm_type: 'way',
      osm_id: 457,
      tags_json: '{"building":"yes","building:part":"apartments"}',
      geometry_json: '{"type":"Point","coordinates":[37.6,55.7]}',
      min_lon: 37.5,
      min_lat: 55.5,
      max_lon: 37.6,
      max_lat: 55.6
    }),
    { requireGeometryJson: true }
  );

  assert.equal(row.feature_kind, 'building');
});

test('parseRowPayload preserves hide-base-when-parts render flags', () => {
  const row = parseRowPayload(
    JSON.stringify({
      osm_type: 'way',
      osm_id: 458,
      tags_json: '{"building":"yes"}',
      geometry_json: '{"type":"Point","coordinates":[37.6,55.7]}',
      min_lon: 37.5,
      min_lat: 55.5,
      max_lon: 37.6,
      max_lat: 55.6,
      render_hide_base_when_parts: 1
    }),
    { requireGeometryJson: true }
  );

  assert.equal(row.render_hide_base_when_parts, 1);
});

test('parseRowPayload preserves building_remainder feature kind', () => {
  const row = parseRowPayload(
    JSON.stringify({
      osm_type: 'way',
      osm_id: 459,
      tags_json: '{"building":"yes"}',
      feature_kind: 'building_remainder',
      geometry_json: '{"type":"Point","coordinates":[37.6,55.7]}',
      min_lon: 37.5,
      min_lat: 55.5,
      max_lon: 37.6,
      max_lat: 55.6
    }),
    { requireGeometryJson: true }
  );

  assert.equal(row.feature_kind, 'building_remainder');
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

test('exportImportRowsToGeojson adds building_remainder features for partially covered import rows', async () => {
  const workspace = createWorkspace(1003);
  const importPath = path.join(workspace, 'region-import.ndjson');
  const geojsonPath = path.join(workspace, 'region-build.ndjson');

  try {
    await writeRowsToNdjsonFile(importPath, [
      {
        osm_type: 'relation',
        osm_id: 12325639,
        tags_json: '{"building":"yes"}',
        feature_kind: 'building',
        geometry_json:
          '{"type":"Polygon","coordinates":[[[44.0,56.0],[44.01,56.0],[44.01,56.01],[44.0,56.01],[44.0,56.0]]]}',
        min_lon: 44.0,
        min_lat: 56.0,
        max_lon: 44.01,
        max_lat: 56.01
      },
      {
        osm_type: 'relation',
        osm_id: 12325634,
        tags_json: '{"building:part":"yes"}',
        feature_kind: 'building_part',
        geometry_json:
          '{"type":"Polygon","coordinates":[[[44.005,56.0],[44.01,56.0],[44.01,56.01],[44.005,56.01],[44.005,56.0]]]}',
        min_lon: 44.005,
        min_lat: 56.0,
        max_lon: 44.01,
        max_lat: 56.01
      }
    ]);

    const summary = await exportImportRowsToGeojson(importPath, geojsonPath);
    const lines = fs
      .readFileSync(geojsonPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const remainder = lines.find((feature) => feature?.properties?.feature_kind === 'building_remainder');
    const baseBuilding = lines.find((feature) => feature?.properties?.feature_kind === 'building');

    assert.equal(summary.importedFeatureCount, 3);
    assert.deepEqual(summary.bounds, {
      west: 44.0,
      south: 56.0,
      east: 44.01,
      north: 56.01
    });
    assert.ok(remainder);
    assert.deepEqual(remainder.geometry, {
      type: 'Polygon',
      coordinates: [
        [
          [44.0, 56.0],
          [44.005, 56.0],
          [44.005, 56.01],
          [44.0, 56.01],
          [44.0, 56.0]
        ]
      ]
    });
    assert.equal(baseBuilding.properties.render_hide_base_when_parts, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('computeGeometryBounds handles Point, Polygon, MultiPolygon and GeometryCollection', () => {
  assert.deepEqual(computeGeometryBounds({ type: 'Point', coordinates: [37.6, 55.7] }), {
    west: 37.6,
    south: 55.7,
    east: 37.6,
    north: 55.7
  });
  assert.deepEqual(
    computeGeometryBounds({
      type: 'Polygon',
      coordinates: [
        [
          [14.0, 49.0],
          [15.5, 49.0],
          [15.5, 50.5],
          [14.0, 50.5],
          [14.0, 49.0]
        ]
      ]
    }),
    { west: 14.0, south: 49.0, east: 15.5, north: 50.5 }
  );
  assert.deepEqual(
    computeGeometryBounds({
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [14.0, 49.0],
            [14.5, 49.0],
            [14.5, 49.5],
            [14.0, 49.5],
            [14.0, 49.0]
          ]
        ],
        [
          [
            [23.0, 54.0],
            [23.5, 54.0],
            [23.5, 54.5],
            [23.0, 54.5],
            [23.0, 54.0]
          ]
        ]
      ]
    }),
    { west: 14.0, south: 49.0, east: 23.5, north: 54.5 }
  );
  assert.deepEqual(
    computeGeometryBounds({
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [14.0, 49.0] },
        { type: 'Point', coordinates: [23.5, 54.5] }
      ]
    }),
    { west: 14.0, south: 49.0, east: 23.5, north: 54.5 }
  );
  assert.equal(computeGeometryBounds(null), null);
  assert.equal(computeGeometryBounds({ type: 'Point', coordinates: [] }), null);
});

test('buildPmtilesFromGeojson shells out to planetiler only', async () => {
  if (process.platform === 'win32') {
    // Bash-based fake binary is only reliable on POSIX; Docker/runtime coverage
    // exercises the real path elsewhere.
    return;
  }

  const workspace = createWorkspace(2003);
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const outputPath = path.join(workspace, 'region.pmtiles');
  const fakePlanetilerPath = path.join(workspace, 'fake-planetiler.sh');
  const logPath = path.join(workspace, 'exec.log');

  try {
    fs.writeFileSync(
      geojsonPath,
      `${formatGeojsonFeatureLine('way', 900100, '{"type":"Point","coordinates":[14.1,49.1]}').trim()}\n`,
      'utf8'
    );
    fs.writeFileSync(
      fakePlanetilerPath,
      [
        '#!/usr/bin/env bash',
        'set -e',
        'if [[ "$1" == "--version" ]]; then echo "fake-planetiler"; exit 0; fi',
        `printf '%s\\n' "$@" >> "${logPath}"`,
        'out=""',
        'for arg in "$@"; do',
        '  if [[ "$arg" == --output=* ]]; then out="${arg#--output=}"; fi',
        'done',
        'if [[ -n "$out" ]]; then : > "$out"; fi',
        'exit 0',
        ''
      ].join('\n'),
      { mode: 0o755 }
    );

    const result = await buildPmtilesFromGeojson({
      region: { slug: 'test-region', pmtilesMinZoom: 13, pmtilesMaxZoom: 16 },
      geojsonPath,
      outputPath,
      env: {
        ...process.env,
        PLANETILER_BIN: fakePlanetilerPath
      }
    });
    const log = fs.readFileSync(logPath, 'utf8');
    const schemaPath = `${outputPath.replace(/\.pmtiles$/i, '')}.planetiler.yml`;

    assert.equal(result.engine, 'planetiler');
    assert.equal(result.mode, 'single');
    assert.equal(result.shardCount, 1);
    assert.match(log, /--output=/);
    assert.match(log, /--minzoom=13/);
    assert.match(log, /--maxzoom=16/);
    assert.ok(fs.existsSync(outputPath));
    assert.ok(fs.existsSync(schemaPath));

    const schema = fs.readFileSync(schemaPath, 'utf8');
    assert.match(schema, /schema_name: "ArchiMap test-region PMTiles"/);
    assert.match(schema, /- key: "feature_kind"/);
    assert.match(schema, /- key: "osm_key"/);
    assert.match(schema, /- key: "osm_type"/);
    assert.match(schema, /- key: "render_hide_base_when_parts"/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildPmtilesFromGeojson reports a single build stage to progress listeners', async () => {
  const workspace = createWorkspace(2004);
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const outputPath = path.join(workspace, 'region.pmtiles');
  const progressEvents = [];

  try {
    fs.writeFileSync(
      geojsonPath,
      `${formatGeojsonFeatureLine('way', 900100, '{"type":"Point","coordinates":[14.1,49.1]}').trim()}\n`,
      'utf8'
    );

    await buildPmtilesFromGeojson({
      region: { slug: 'progress-region' },
      geojsonPath,
      outputPath,
      onShardProgress(event) {
        progressEvents.push(event);
      },
      env: {
        ...process.env,
        PLANETILER_BIN: process.execPath
      }
    }).catch((error) => {
      assert.match(String(error.message || error), /failed with exit code|Cannot find module|Unknown option/);
    });

    assert.equal(progressEvents.length, 1);
    assert.equal(progressEvents[0].stage, 'build');
    assert.equal(progressEvents[0].detail, 'planetiler (single pass)');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
