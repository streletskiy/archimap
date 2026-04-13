const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const {
  buildFeature3dPropertiesFromTagsJson,
  createWorkspace,
  formatGeojsonFeatureLine,
  parseRowPayload,
  writeRowsToNdjsonFile
} = require('../../scripts/region-sync/common');
const {
  assignCellIndex,
  buildPmtilesFromGeojson,
  computeGeometryBounds,
  DEFAULT_SHARD_KM,
  DEFAULT_SHARD_MIN_FEATURES,
  exportImportRowsToGeojson,
  planShardGrid,
  resolveShardKm,
  resolveShardMinFeatures,
  summarizeImportRows,
  writeShardNdjsons
} = require('../../scripts/region-sync/pmtiles-builder');
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
    '{"type":"Feature","id":247,"properties":{"osm_id":123,"feature_kind":"building","render_height_m":3.2,"render_min_height_m":0,"render_hide_base_when_parts":0},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
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
    '{"type":"Feature","id":248,"properties":{"osm_id":124,"feature_kind":"building_part","render_height_m":3.2,"render_min_height_m":0,"render_hide_base_when_parts":0},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
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
    '{"type":"Feature","id":250,"properties":{"osm_id":125,"feature_kind":"building","render_height_m":3.2,"render_min_height_m":0,"render_hide_base_when_parts":0},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
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
    '{"type":"Feature","id":253,"properties":{"osm_id":126,"feature_kind":"building","render_height_m":3.2,"render_min_height_m":0,"render_hide_base_when_parts":1},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
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
    '{"type":"Feature","id":254,"properties":{"osm_id":127,"feature_kind":"building_remainder","render_height_m":3.2,"render_min_height_m":0,"render_hide_base_when_parts":0},"geometry":{"type":"Point","coordinates":[37.6,55.7]}}\n'
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
  const properties = buildFeature3dPropertiesFromTagsJson('{"building:levels":"4","building:height":"18.5","min_height":"5.5"}');

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
  const row = parseRowPayload(JSON.stringify({
    osm_type: 'relation',
    osm_id: 456,
    tags_json: '{"building:part":"apartments"}',
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
    tags_json: '{"building":"yes","building:part":"apartments"}',
    geometry_json: '{"type":"Point","coordinates":[37.6,55.7]}',
    min_lon: 37.5,
    min_lat: 55.5,
    max_lon: 37.6,
    max_lat: 55.6
  }), { requireGeometryJson: true });

  assert.equal(row.feature_kind, 'building');
});

test('parseRowPayload preserves hide-base-when-parts render flags', () => {
  const row = parseRowPayload(JSON.stringify({
    osm_type: 'way',
    osm_id: 458,
    tags_json: '{"building":"yes"}',
    geometry_json: '{"type":"Point","coordinates":[37.6,55.7]}',
    min_lon: 37.5,
    min_lat: 55.5,
    max_lon: 37.6,
    max_lat: 55.6,
    render_hide_base_when_parts: 1
  }), { requireGeometryJson: true });

  assert.equal(row.render_hide_base_when_parts, 1);
});

test('parseRowPayload preserves building_remainder feature kind', () => {
  const row = parseRowPayload(JSON.stringify({
    osm_type: 'way',
    osm_id: 459,
    tags_json: '{"building":"yes"}',
    feature_kind: 'building_remainder',
    geometry_json: '{"type":"Point","coordinates":[37.6,55.7]}',
    min_lon: 37.5,
    min_lat: 55.5,
    max_lon: 37.6,
    max_lat: 55.6
  }), { requireGeometryJson: true });

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

test('exportImportRowsToGeojson adds building_remainder features for partially covered sqlite import rows', async () => {
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
        geometry_json: '{"type":"Polygon","coordinates":[[[44.0,56.0],[44.01,56.0],[44.01,56.01],[44.0,56.01],[44.0,56.0]]]}',
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
        geometry_json: '{"type":"Polygon","coordinates":[[[44.005,56.0],[44.01,56.0],[44.01,56.01],[44.005,56.01],[44.005,56.0]]]}',
        min_lon: 44.005,
        min_lat: 56.0,
        max_lon: 44.01,
        max_lat: 56.01
      }
    ]);

    const summary = await exportImportRowsToGeojson(importPath, geojsonPath);
    const lines = fs.readFileSync(geojsonPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
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
      coordinates: [[
        [44.0, 56.0],
        [44.005, 56.0],
        [44.005, 56.01],
        [44.0, 56.01],
        [44.0, 56.0]
      ]]
    });
    assert.equal(baseBuilding.properties.render_hide_base_when_parts, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('resolveShardKm honors explicit argument, env fallback, and default', () => {
  assert.equal(resolveShardKm(120, {}), 120);
  assert.equal(resolveShardKm(0, {}), 0);
  assert.equal(resolveShardKm(undefined, { REGION_SYNC_SHARD_KM: '45' }), 45);
  assert.equal(resolveShardKm(undefined, { REGION_SYNC_SHARD_KM: 'not-a-number' }), DEFAULT_SHARD_KM);
  assert.equal(resolveShardKm(undefined, {}), DEFAULT_SHARD_KM);
  assert.equal(resolveShardKm(-25, {}), 0);
});

test('resolveShardMinFeatures honors env override and clamps invalid values', () => {
  assert.equal(resolveShardMinFeatures({}), DEFAULT_SHARD_MIN_FEATURES);
  assert.equal(resolveShardMinFeatures({ REGION_SYNC_SHARD_MIN_FEATURES: '25000' }), 25000);
  assert.equal(resolveShardMinFeatures({ REGION_SYNC_SHARD_MIN_FEATURES: '-10' }), DEFAULT_SHARD_MIN_FEATURES);
  assert.equal(resolveShardMinFeatures({ REGION_SYNC_SHARD_MIN_FEATURES: 'foo' }), DEFAULT_SHARD_MIN_FEATURES);
});

test('planShardGrid returns null for disabled sharding or invalid bounds', () => {
  assert.equal(planShardGrid(null, 60), null);
  assert.equal(planShardGrid({ west: 0, south: 0, east: 1, north: 1 }, 0), null);
  assert.equal(planShardGrid({ west: 1, south: 1, east: 1, north: 1 }, 60), null);
  assert.equal(planShardGrid({ west: 0, south: 0, east: NaN, north: 1 }, 60), null);
});

test('planShardGrid divides a Poland-sized bbox into roughly km-sized cells', () => {
  // Poland bbox ~ (14.12, 49.00, 24.15, 54.84)
  const grid = planShardGrid({ west: 14.12, south: 49.00, east: 24.15, north: 54.84 }, 60);

  assert.ok(grid);
  assert.equal(grid.minLon, 14.12);
  assert.equal(grid.minLat, 49.00);
  assert.equal(grid.shardKm, 60);
  // 5.84° lat / (60/111.32)° per cell ≈ 10.84 → 11 rows
  assert.equal(grid.rows, 11);
  // ~10° lon / cell step at ~52° lat ≈ 0.875° → 12 cols
  assert.equal(grid.cols, 12);
  assert.equal(grid.cellCount, grid.rows * grid.cols);
  assert.ok(grid.latStep > 0);
  assert.ok(grid.lonStep > grid.latStep); // lon degrees are smaller at mid-latitudes
});

test('planShardGrid collapses tiny regions into a single cell', () => {
  const grid = planShardGrid({ west: 14.42, south: 50.07, east: 14.46, north: 50.10 }, 60);
  assert.ok(grid);
  assert.equal(grid.rows, 1);
  assert.equal(grid.cols, 1);
  assert.equal(grid.cellCount, 1);
});

test('assignCellIndex maps feature bbox centers into the right cell and clamps outliers', () => {
  const grid = planShardGrid({ west: 14.00, south: 49.00, east: 24.00, north: 55.00 }, 60);

  const swCorner = assignCellIndex({ west: 14.05, south: 49.05, east: 14.06, north: 49.06 }, grid);
  const neCorner = assignCellIndex({ west: 23.95, south: 54.95, east: 23.96, north: 54.96 }, grid);
  const outside = assignCellIndex({ west: 30.0, south: 60.0, east: 30.1, north: 60.1 }, grid);

  assert.deepEqual(swCorner, { row: 0, col: 0, key: '0-0' });
  assert.equal(neCorner.row, grid.rows - 1);
  assert.equal(neCorner.col, grid.cols - 1);
  assert.equal(outside.row, grid.rows - 1);
  assert.equal(outside.col, grid.cols - 1);
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
      coordinates: [[[14.0, 49.0], [15.5, 49.0], [15.5, 50.5], [14.0, 50.5], [14.0, 49.0]]]
    }),
    { west: 14.0, south: 49.0, east: 15.5, north: 50.5 }
  );
  assert.deepEqual(
    computeGeometryBounds({
      type: 'MultiPolygon',
      coordinates: [
        [[[14.0, 49.0], [14.5, 49.0], [14.5, 49.5], [14.0, 49.5], [14.0, 49.0]]],
        [[[23.0, 54.0], [23.5, 54.0], [23.5, 54.5], [23.0, 54.5], [23.0, 54.0]]]
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

test('writeShardNdjsons splits GeoJSON NDJSON into per-cell files', async () => {
  const workspace = createWorkspace(2001);
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const shardDir = path.join(workspace, 'shards');

  try {
    const lines = [
      formatGeojsonFeatureLine(
        'way', 900001,
        '{"type":"Polygon","coordinates":[[[14.05,49.05],[14.06,49.05],[14.06,49.06],[14.05,49.06],[14.05,49.05]]]}'
      ),
      formatGeojsonFeatureLine(
        'way', 900002,
        '{"type":"Polygon","coordinates":[[[23.90,54.80],[23.91,54.80],[23.91,54.81],[23.90,54.81],[23.90,54.80]]]}'
      ),
      formatGeojsonFeatureLine(
        'way', 900003,
        '{"type":"Polygon","coordinates":[[[14.10,49.10],[14.11,49.10],[14.11,49.11],[14.10,49.11],[14.10,49.10]]]}'
      )
    ];
    fs.writeFileSync(geojsonPath, lines.join(''), 'utf8');

    const grid = planShardGrid({ west: 14.00, south: 49.00, east: 24.00, north: 55.00 }, 60);
    const result = await writeShardNdjsons({ geojsonPath, grid, workspaceDir: shardDir });

    assert.equal(result.skippedFeatureCount, 0);
    assert.equal(result.shards.length, 2);
    const counts = result.shards.map((shard) => shard.count).sort((a, b) => a - b);
    assert.deepEqual(counts, [1, 2]);
    for (const shard of result.shards) {
      const shardLines = fs.readFileSync(shard.path, 'utf8').trim().split('\n');
      assert.equal(shardLines.length, shard.count);
      for (const line of shardLines) {
        const parsed = JSON.parse(line);
        assert.equal(parsed.type, 'Feature');
      }
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('writeShardNdjsons skips unparseable lines and features without geometry', async () => {
  const workspace = createWorkspace(2002);
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const shardDir = path.join(workspace, 'shards');

  try {
    fs.writeFileSync(
      geojsonPath,
      [
        'not json at all',
        JSON.stringify({ type: 'Feature', properties: {}, geometry: null }),
        formatGeojsonFeatureLine(
          'way', 900010,
          '{"type":"Point","coordinates":[14.1,49.1]}'
        ).trim()
      ].join('\n'),
      'utf8'
    );

    const grid = planShardGrid({ west: 14.0, south: 49.0, east: 24.0, north: 55.0 }, 60);
    const result = await writeShardNdjsons({ geojsonPath, grid, workspaceDir: shardDir });

    assert.equal(result.skippedFeatureCount, 2);
    assert.equal(result.shards.length, 1);
    assert.equal(result.shards[0].count, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildPmtilesFromGeojson uses single-pass path when sharding is disabled or under floor', async () => {
  if (process.platform === 'win32') {
    // Bash-based fake binary is only reliable on POSIX; the functional path is
    // covered by the Docker smoke build on CI/Linux.
    return;
  }

  const workspace = createWorkspace(2003);
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const outputPath = path.join(workspace, 'region.pmtiles');
  const fakeTippecanoePath = path.join(workspace, 'fake-tippecanoe.sh');
  const logPath = path.join(workspace, 'exec.log');

  try {
    fs.writeFileSync(
      geojsonPath,
      `${formatGeojsonFeatureLine('way', 900100, '{"type":"Point","coordinates":[14.1,49.1]}').trim()}\n`,
      'utf8'
    );
    fs.writeFileSync(
      fakeTippecanoePath,
      [
        '#!/usr/bin/env bash',
        'set -e',
        `printf '%s\\n' "$@" >> "${logPath}"`,
        'out=""',
        'for ((i=1;i<=$#;i++)); do',
        '  if [[ "${!i}" == "-o" ]]; then',
        '    j=$((i+1)); out="${!j}";',
        '  fi',
        'done',
        'if [[ "$1" == "--version" ]]; then echo "fake-tippecanoe"; exit 0; fi',
        'if [[ -n "$out" ]]; then : > "$out"; fi',
        'exit 0',
        ''
      ].join('\n'),
      { mode: 0o755 }
    );

    const fakeEnv = { ...process.env, TIPPECANOE_BIN: fakeTippecanoePath, TILE_JOIN_BIN: fakeTippecanoePath };

    const disabled = await buildPmtilesFromGeojson({
      region: { pmtilesMinZoom: 13, pmtilesMaxZoom: 16 },
      geojsonPath,
      outputPath,
      bounds: { west: 14, south: 49, east: 24, north: 55 },
      featureCount: 500_000,
      shardKm: 0,
      env: fakeEnv
    });
    assert.equal(disabled.mode, 'single');
    assert.equal(disabled.shardCount, 1);

    // An explicit REGION_SYNC_SHARD_MIN_FEATURES floor still short-circuits
    // sharding for small regions even though the default is now adaptive.
    const belowFloor = await buildPmtilesFromGeojson({
      region: { pmtilesMinZoom: 13, pmtilesMaxZoom: 16 },
      geojsonPath,
      outputPath,
      bounds: { west: 14, south: 49, east: 24, north: 55 },
      featureCount: 100,
      shardKm: 60,
      env: { ...fakeEnv, REGION_SYNC_SHARD_MIN_FEATURES: '1000' }
    });
    assert.equal(belowFloor.mode, 'single');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildPmtilesFromGeojson reuses cached shard archives on repeated runs', async () => {
  if (process.platform === 'win32') {
    // Bash-based fake binary is only reliable on POSIX; the functional path is
    // covered by the Docker smoke build on CI/Linux.
    return;
  }

  const workspace = createWorkspace(2004);
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const outputPath = path.join(workspace, 'region.pmtiles');
  const cacheDir = path.join(workspace, 'cache');
  const fakeTippecanoePath = path.join(workspace, 'fake-tippecanoe.sh');
  const logPath = path.join(workspace, 'exec.log');

  try {
    fs.writeFileSync(
      geojsonPath,
      [
        formatGeojsonFeatureLine('way', 910001, '{"type":"Polygon","coordinates":[[[14.05,49.05],[14.06,49.05],[14.06,49.06],[14.05,49.06],[14.05,49.05]]]}').trim(),
        formatGeojsonFeatureLine('way', 910002, '{"type":"Polygon","coordinates":[[[23.90,54.80],[23.91,54.80],[23.91,54.81],[23.90,54.81],[23.90,54.80]]]}').trim(),
        formatGeojsonFeatureLine('way', 910003, '{"type":"Polygon","coordinates":[[[14.10,49.10],[14.11,49.10],[14.11,49.11],[14.10,49.11],[14.10,49.10]]]}').trim()
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      fakeTippecanoePath,
      [
        '#!/usr/bin/env bash',
        'set -e',
        'if [[ "$1" == "--version" ]]; then echo "fake-tippecanoe"; exit 0; fi',
        'if [[ "$#" -eq 0 ]]; then exit 0; fi',
        `printf '%s\\n' "$*" >> "${logPath}"`,
        'out=""',
        'for ((i=1;i<=$#;i++)); do',
        '  if [[ "${!i}" == "-o" ]]; then',
        '    j=$((i+1)); out="${!j}";',
        '  fi',
        'done',
        'if [[ -n "$out" ]]; then : > "$out"; fi',
        'exit 0',
        ''
      ].join('\n'),
      { mode: 0o755 }
    );

    const fakeEnv = {
      ...process.env,
      TIPPECANOE_BIN: fakeTippecanoePath,
      TILE_JOIN_BIN: fakeTippecanoePath,
      REGION_SYNC_SHARD_MIN_FEATURES: '0'
    };

    const first = await buildPmtilesFromGeojson({
      region: { pmtilesMinZoom: 13, pmtilesMaxZoom: 16 },
      geojsonPath,
      outputPath,
      bounds: { west: 14, south: 49, east: 24, north: 55 },
      featureCount: 3,
      shardKm: 60,
      shardCacheDir: cacheDir,
      env: fakeEnv
    });
    const second = await buildPmtilesFromGeojson({
      region: { pmtilesMinZoom: 13, pmtilesMaxZoom: 16 },
      geojsonPath,
      outputPath,
      bounds: { west: 14, south: 49, east: 24, north: 55 },
      featureCount: 3,
      shardKm: 60,
      shardCacheDir: cacheDir,
      env: fakeEnv
    });

    const logLines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    const tippecanoeInvocations = logLines.filter((line) => line.includes('--detect-shared-borders'));
    const tileJoinInvocations = logLines.filter((line) => line.includes('--no-tile-size-limit'));

    assert.equal(first.mode, 'sharded-cache');
    assert.equal(first.rebuiltShardCount, first.shardCount);
    assert.equal(first.reusedShardCount, 0);
    assert.equal(second.mode, 'sharded-cache');
    assert.equal(second.rebuiltShardCount, 0);
    assert.equal(second.reusedShardCount, second.shardCount);
    assert.equal(tippecanoeInvocations.length, first.shardCount);
    assert.equal(tileJoinInvocations.length, 2);
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

test('exportRegionMembersToGeojsonNdjson adds building_remainder rows for sqlite pmtiles-only rebuilds', async () => {
  const workspace = createWorkspace(1004);
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
        (11, 'relation', 12325639),
        (11, 'relation', 12325634);
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
        ('relation', 12325639, '{"building":"yes"}', '{"type":"Polygon","coordinates":[[[44.0,56.0],[44.01,56.0],[44.01,56.01],[44.0,56.01],[44.0,56.0]]]}', 44.0, 56.0, 44.01, 56.01),
        ('relation', 12325634, '{"building:part":"yes"}', '{"type":"Polygon","coordinates":[[[44.005,56.0],[44.01,56.0],[44.01,56.01],[44.005,56.01],[44.005,56.0]]]}', 44.005, 56.0, 44.01, 56.01);
    `);
    osmDb.close();

    const summary = await exportRegionMembersToGeojsonNdjson({
      dbProvider: 'sqlite',
      archimapDbPath,
      osmDbPath,
      regionId: 11,
      outputPath
    });
    const lines = fs.readFileSync(outputPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const remainder = lines.find((feature) => feature?.properties?.feature_kind === 'building_remainder');
    const baseBuilding = lines.find((feature) => feature?.properties?.feature_kind === 'building');

    assert.equal(summary.importedFeatureCount, 3);
    assert.ok(remainder);
    assert.deepEqual(remainder.geometry, {
      type: 'Polygon',
      coordinates: [[
        [44.0, 56.0],
        [44.005, 56.0],
        [44.005, 56.01],
        [44.0, 56.01],
        [44.0, 56.0]
      ]]
    });
    assert.equal(baseBuilding.properties.render_hide_base_when_parts, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
