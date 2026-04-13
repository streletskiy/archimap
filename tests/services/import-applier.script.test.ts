const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyRegionImport,
  buildPostgresCopyTextLine,
  computePostgresContourSummaryTotal,
  escapePostgresCopyTextValue,
  resolveImportApplyBatchSize
} = require('../../scripts/region-sync/import-applier');
const { writeRowsToNdjsonFile } = require('../../scripts/region-sync/common');

test('resolveImportApplyBatchSize keeps defaults and clamps oversized env values', () => {
  assert.equal(resolveImportApplyBatchSize({}), 1000);
  assert.equal(resolveImportApplyBatchSize({
    REGION_SYNC_IMPORT_APPLY_BATCH_SIZE: '5000'
  }), 5000);
  assert.equal(resolveImportApplyBatchSize({
    REGION_SYNC_IMPORT_APPLY_BATCH_SIZE: '50000'
  }), 8000);
  assert.equal(resolveImportApplyBatchSize({
    REGION_SYNC_IMPORT_APPLY_BATCH_SIZE: 'invalid'
  }), 1000);
});

test('escapePostgresCopyTextValue formats nulls and control characters for COPY text', () => {
  assert.equal(escapePostgresCopyTextValue(null), '\\N');
  assert.equal(
    escapePostgresCopyTextValue('one\\two\tthree\nfour\rfive'),
    'one\\\\two\\tthree\\nfour\\rfive'
  );
});

test('buildPostgresCopyTextLine serializes importer rows for COPY text format', () => {
  assert.equal(buildPostgresCopyTextLine({
    osm_type: 'way',
    osm_id: 42,
    tags_json: '{"name":"A\\tB"}',
    geometry_wkb_hex: 'ABCD',
    min_lon: 1.25,
    min_lat: 2.5,
    max_lon: 3.75,
    max_lat: 4
  }), 'way\t42\t{"name":"A\\\\tB"}\tABCD\t1.25\t2.5\t3.75\t4\n');
});

test('computePostgresContourSummaryTotal applies insert and orphan deltas', () => {
  assert.equal(computePostgresContourSummaryTotal(100, 25, 10), 115);
  assert.equal(computePostgresContourSummaryTotal(3, 0, 10), 0);
});

test('applyRegionImport batches sqlite imports and keeps only ids in temp cleanup state', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-import-applier-'));
  const archimapDbPath = path.join(workspace, 'archimap.db');
  const osmDbPath = path.join(workspace, 'osm.db');
  const ndjsonPath = path.join(workspace, 'region-import.ndjson');
  const builtPmtilesPath = path.join(workspace, 'region.pmtiles');
  const dataDir = path.join(workspace, 'data');
  const region = { id: 7, slug: 'batched-region-sync' };
  const importedRows = [];
  const progressEvents = [];

  try {
    for (let osmId = 1; osmId <= 1002; osmId += 1) {
      const lon = 30 + (osmId / 10000);
      const lat = 60 + (osmId / 10000);
      importedRows.push({
        osm_type: 'way',
        osm_id: osmId,
        tags_json: JSON.stringify({
          building: osmId === 1 ? 'apartments' : 'yes',
          ref: `import-${osmId}`
        }),
        geometry_json: JSON.stringify({
          type: 'Point',
          coordinates: [lon, lat]
        }),
        min_lon: lon,
        min_lat: lat,
        max_lon: lon,
        max_lat: lat
      });
    }

    const archimapDb = new Database(archimapDbPath);
    archimapDb.exec(`
      CREATE TABLE data_region_memberships (
        region_id INTEGER NOT NULL,
        osm_type TEXT NOT NULL,
        osm_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (region_id, osm_type, osm_id)
      );
    `);
    const insertMembership = archimapDb.prepare(`
      INSERT INTO data_region_memberships (
        region_id,
        osm_type,
        osm_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?)
    `);
    const seedMemberships = archimapDb.transaction(() => {
      for (let osmId = 1; osmId <= 1003; osmId += 1) {
        insertMembership.run(7, 'way', osmId, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
      }
      insertMembership.run(7, 'way', 2000, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
      insertMembership.run(8, 'way', 2000, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    });
    seedMemberships();
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
        max_lat REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (osm_type, osm_id)
      );
    `);
    const insertContour = osmDb.prepare(`
      INSERT INTO building_contours (
        osm_type,
        osm_id,
        tags_json,
        geometry_json,
        min_lon,
        min_lat,
        max_lon,
        max_lat,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const seedContours = osmDb.transaction(() => {
      for (let osmId = 1; osmId <= 1003; osmId += 1) {
        const lon = 10 + (osmId / 10000);
        const lat = 20 + (osmId / 10000);
        insertContour.run(
          'way',
          osmId,
          JSON.stringify({ building: 'old', ref: `stale-${osmId}` }),
          JSON.stringify({ type: 'Point', coordinates: [lon, lat] }),
          lon,
          lat,
          lon,
          lat,
          '2024-01-01T00:00:00.000Z'
        );
      }
      insertContour.run(
        'way',
        2000,
        JSON.stringify({ building: 'shared' }),
        JSON.stringify({ type: 'Point', coordinates: [55, 65] }),
        55,
        65,
        55,
        65,
        '2024-01-01T00:00:00.000Z'
      );
    });
    seedContours();
    osmDb.close();

    await writeRowsToNdjsonFile(ndjsonPath, importedRows);
    fs.writeFileSync(builtPmtilesPath, 'pmtiles', 'utf8');

    const result = await applyRegionImport({
      dbProvider: 'sqlite',
      region,
      ndjsonPath,
      builtPmtilesPath,
      archimapDbPath,
      osmDbPath,
      dataDir,
      totalFeatureCount: importedRows.length,
      onProgress: (event) => progressEvents.push({
        step: event?.step,
        progress: event?.progress,
        detail: event?.detail,
        processedFeatureCount: event?.processedFeatureCount,
        totalFeatureCount: event?.totalFeatureCount
      })
    });

    const finalPmtilesPath = path.join(dataDir, 'regions', 'buildings-region-batched-region-sync.pmtiles');
    assert.equal(result.importedFeatureCount, 1002);
    assert.equal(result.activeFeatureCount, 1002);
    assert.equal(result.orphanDeletedCount, 1);
    assert.equal(result.pmtilesPath, finalPmtilesPath);
    assert.equal(result.pmtilesBytes, 7);
    assert.equal(fs.readFileSync(finalPmtilesPath, 'utf8'), 'pmtiles');
    assert.deepEqual(progressEvents, [
      {
        step: 'rows',
        progress: 0,
        detail: 'writing imported rows 0/1002',
        processedFeatureCount: 0,
        totalFeatureCount: 1002
      },
      {
        step: 'rows',
        progress: 69,
        detail: 'writing imported rows 1000/1002',
        processedFeatureCount: 1000,
        totalFeatureCount: 1002
      },
      {
        step: 'rows',
        progress: 70,
        detail: 'writing imported rows 1002/1002',
        processedFeatureCount: 1002,
        totalFeatureCount: 1002
      },
      {
        step: 'stale_memberships',
        progress: 94,
        detail: 'removing stale region memberships',
        processedFeatureCount: 1002,
        totalFeatureCount: 1002
      },
      {
        step: 'orphan_cleanup',
        progress: 98,
        detail: 'removing orphan contours',
        processedFeatureCount: 1002,
        totalFeatureCount: 1002
      },
      {
        step: 'complete',
        progress: 100,
        detail: 'database import applied',
        processedFeatureCount: 1002,
        totalFeatureCount: 1002
      }
    ]);

    const verifyArchimapDb = new Database(archimapDbPath, { readonly: true });
    const membershipsByRegion = verifyArchimapDb.prepare(`
      SELECT region_id, COUNT(*) AS total
      FROM data_region_memberships
      GROUP BY region_id
      ORDER BY region_id
    `).all();
    const removedRegionMembership = verifyArchimapDb.prepare(`
      SELECT COUNT(*) AS total
      FROM data_region_memberships
      WHERE region_id = 7
        AND osm_type = 'way'
        AND osm_id IN (1003, 2000)
    `).get();
    verifyArchimapDb.close();

    assert.deepEqual(membershipsByRegion, [
      { region_id: 7, total: 1002 },
      { region_id: 8, total: 1 }
    ]);
    assert.equal(Number(removedRegionMembership?.total || 0), 0);

    const verifyOsmDb = new Database(osmDbPath, { readonly: true });
    const contourCount = verifyOsmDb.prepare(`
      SELECT COUNT(*) AS total
      FROM building_contours
    `).get();
    const updatedContour = verifyOsmDb.prepare(`
      SELECT tags_json, geometry_json
      FROM building_contours
      WHERE osm_type = 'way' AND osm_id = 1
    `).get();
    const removedContour = verifyOsmDb.prepare(`
      SELECT COUNT(*) AS total
      FROM building_contours
      WHERE osm_type = 'way' AND osm_id = 1003
    `).get();
    const sharedContour = verifyOsmDb.prepare(`
      SELECT tags_json
      FROM building_contours
      WHERE osm_type = 'way' AND osm_id = 2000
    `).get();
    verifyOsmDb.close();

    assert.equal(Number(contourCount?.total || 0), 1003);
    assert.deepEqual(JSON.parse(updatedContour.tags_json), {
      building: 'apartments',
      ref: 'import-1'
    });
    assert.deepEqual(JSON.parse(updatedContour.geometry_json), {
      type: 'Point',
      coordinates: [30.0001, 60.0001]
    });
    assert.equal(Number(removedContour?.total || 0), 0);
    assert.deepEqual(JSON.parse(sharedContour.tags_json), {
      building: 'shared'
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('applyRegionImport supports db-only mode without publishing pmtiles', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-import-applier-db-only-'));
  const archimapDbPath = path.join(workspace, 'archimap.db');
  const osmDbPath = path.join(workspace, 'osm.db');
  const ndjsonPath = path.join(workspace, 'region-import.ndjson');

  try {
    const archimapDb = new Database(archimapDbPath);
    archimapDb.exec(`
      CREATE TABLE data_region_memberships (
        region_id INTEGER NOT NULL,
        osm_type TEXT NOT NULL,
        osm_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (region_id, osm_type, osm_id)
      );
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
        max_lat REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (osm_type, osm_id)
      );
    `);
    osmDb.close();

    await writeRowsToNdjsonFile(ndjsonPath, [{
      osm_type: 'way',
      osm_id: 1,
      tags_json: '{"building":"yes"}',
      geometry_json: '{"type":"Point","coordinates":[30,60]}',
      min_lon: 30,
      min_lat: 60,
      max_lon: 30,
      max_lat: 60
    }]);

    const result = await applyRegionImport({
      dbProvider: 'sqlite',
      region: { id: 3, slug: 'db-only-import' },
      ndjsonPath,
      archimapDbPath,
      osmDbPath,
      dataDir: path.join(workspace, 'data')
    });

    assert.equal(result.importedFeatureCount, 1);
    assert.equal(result.activeFeatureCount, 1);
    assert.equal(result.orphanDeletedCount, 0);
    assert.equal(result.pmtilesBytes, null);
    assert.equal(result.pmtilesPath, null);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
