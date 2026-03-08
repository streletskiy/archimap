const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const migration = require('../../db/migrations/003_data_regions.migration.js');
const filterTagAllowlistMigration = require('../../db/migrations/005_filter_tag_allowlist.migration.js');
const {
  createDataSettingsService,
  buildRegionPmtilesFileName,
  resolveRegionPmtilesPath,
  resolveLegacyRegionPmtilesPath,
  resolveExistingRegionPmtilesPath
} = require('../../src/lib/server/services/data-settings.service');
const { DEFAULT_FILTER_TAG_ALLOWLIST } = require('../../src/lib/server/services/filter-tags.service');

function createTestDb() {
  const db = new Database(':memory:');
  migration.up(db);
  filterTagAllowlistMigration.up(db);
  return db;
}

function ensureContoursTable(db) {
  const dbList = db.prepare('PRAGMA database_list').all();
  if (!dbList.some((row) => String(row?.name || '') === 'osm')) {
    db.prepare("ATTACH DATABASE ':memory:' AS osm").run();
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS osm.building_contours (
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      tags_json TEXT,
      geometry_json TEXT NOT NULL,
      min_lon REAL NOT NULL,
      min_lat REAL NOT NULL,
      max_lon REAL NOT NULL,
      max_lat REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (osm_type, osm_id)
    );
  `);
}

test('region PMTiles filenames use slug and resolve legacy id fallback during migration', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-region-pmtiles-'));
  const region = {
    id: 17,
    slug: 'ivanovo-oblast'
  };

  try {
    assert.equal(buildRegionPmtilesFileName(region), 'buildings-region-ivanovo-oblast.pmtiles');

    const slugPath = resolveRegionPmtilesPath(tempDir, region);
    const legacyPath = resolveLegacyRegionPmtilesPath(tempDir, region.id);
    assert.equal(path.basename(slugPath), 'buildings-region-ivanovo-oblast.pmtiles');
    assert.equal(path.basename(legacyPath), 'buildings-region-17.pmtiles');

    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, Buffer.alloc(16, 1));
    assert.equal(resolveExistingRegionPmtilesPath(tempDir, region), legacyPath);

    fs.writeFileSync(slugPath, Buffer.alloc(16, 2));
    assert.equal(resolveExistingRegionPmtilesPath(tempDir, region), slugPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('bootstrapFromEnvIfNeeded records db-only bootstrap without creating regions', async () => {
  const db = createTestDb();
  const service = createDataSettingsService({
    db,
    fallbackData: {
      autoSyncEnabled: true,
      autoSyncOnStart: false,
      autoSyncIntervalHours: 72,
      pmtilesMinZoom: 12,
      pmtilesMaxZoom: 15,
      sourceLayer: 'buildings'
    }
  });

  const first = await service.bootstrapFromEnvIfNeeded('bootstrap-test');
  assert.equal(first.imported, false);
  assert.equal(first.regions.length, 0);

  const second = await service.bootstrapFromEnvIfNeeded('bootstrap-test');
  assert.equal(second.imported, false);

  const regions = await service.listRegions();
  assert.equal(regions.length, 0);

  const bootstrapState = await service.getBootstrapState();
  assert.equal(bootstrapState.completed, true);
  assert.equal(bootstrapState.source, 'db-only');
});

test('filter tag allowlist uses important defaults when DB config is absent', async () => {
  const db = createTestDb();
  const service = createDataSettingsService({
    db,
    fallbackData: {
      autoSyncEnabled: true,
      autoSyncOnStart: false,
      autoSyncIntervalHours: 72,
      pmtilesMinZoom: 12,
      pmtilesMaxZoom: 15,
      sourceLayer: 'buildings'
    }
  });

  const settings = await service.getFilterTagAllowlistForAdmin();
  assert.equal(settings.source, 'default');
  assert.deepEqual(settings.allowlist, DEFAULT_FILTER_TAG_ALLOWLIST);
  assert.deepEqual(settings.defaultAllowlist, DEFAULT_FILTER_TAG_ALLOWLIST);
});

test('saveFilterTagAllowlist persists normalized DB-backed allowlist', async () => {
  const db = createTestDb();
  const service = createDataSettingsService({
    db,
    fallbackData: {
      autoSyncEnabled: true,
      autoSyncOnStart: false,
      autoSyncIntervalHours: 72,
      pmtilesMinZoom: 12,
      pmtilesMaxZoom: 15,
      sourceLayer: 'buildings'
    }
  });

  const saved = await service.saveFilterTagAllowlist([
    'roof:shape',
    'building',
    'roof:shape',
    ' building:architecture '
  ], 'tester@example.com');

  assert.equal(saved.source, 'db');
  assert.deepEqual(saved.allowlist, ['building', 'building:architecture', 'roof:shape']);
  assert.equal(saved.updatedBy, 'tester@example.com');
});

test('saveRegion allows renaming existing region while preserving id', async () => {
  const db = createTestDb();
  const service = createDataSettingsService({
    db,
    fallbackData: {
      autoSyncEnabled: true,
      autoSyncOnStart: false,
      autoSyncIntervalHours: 24,
      pmtilesMinZoom: 13,
      pmtilesMaxZoom: 16,
      sourceLayer: 'buildings'
    }
  });

  const created = await service.saveRegion({
    name: 'Original Region',
    slug: 'original-region',
    sourceType: 'extract_query',
    sourceValue: 'Original Region',
    enabled: true,
    autoSyncEnabled: true,
    autoSyncIntervalHours: 24
  }, 'tester');

  const renamed = await service.saveRegion({
    id: created.id,
    name: 'Renamed Region',
    slug: 'renamed-region',
    sourceType: 'extract_query',
    sourceValue: 'Original Region',
    enabled: true,
    autoSyncEnabled: true,
    autoSyncIntervalHours: 24
  }, 'tester');

  assert.equal(renamed.id, created.id);
  assert.equal(renamed.name, 'Renamed Region');
  assert.equal(renamed.slug, 'renamed-region');
});

test('getDataSettingsForAdmin includes PMTiles size from disk and DB storage bytes for region', async () => {
  const db = createTestDb();
  ensureContoursTable(db);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-region-storage-'));
  const service = createDataSettingsService({
    db,
    dataDir: tempDir,
    fallbackData: {
      autoSyncEnabled: true,
      autoSyncOnStart: false,
      autoSyncIntervalHours: 24,
      pmtilesMinZoom: 13,
      pmtilesMaxZoom: 16,
      sourceLayer: 'buildings'
    }
  });

  try {
    const region = await service.saveRegion({
      name: 'Storage Region',
      slug: 'storage-region',
      sourceType: 'extract_query',
      sourceValue: 'Storage Region',
      enabled: true,
      autoSyncEnabled: true,
      autoSyncIntervalHours: 24
    }, 'tester');

    const pmtilesPath = resolveRegionPmtilesPath(tempDir, region);
    fs.mkdirSync(path.dirname(pmtilesPath), { recursive: true });
    fs.writeFileSync(pmtilesPath, Buffer.alloc(1536, 7));

    db.prepare(`
      INSERT INTO osm.building_contours (
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      'way',
      101,
      JSON.stringify({ building: 'yes', name: 'Storage test' }),
      JSON.stringify({
        type: 'MultiPolygon',
        coordinates: [[[[37.6, 55.7], [37.61, 55.7], [37.61, 55.71], [37.6, 55.71], [37.6, 55.7]]]]
      }),
      37.6,
      55.7,
      37.61,
      55.71
    );
    db.prepare(`
      INSERT INTO data_region_memberships (
        region_id,
        osm_type,
        osm_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
    `).run(region.id, 'way', 101);

    const settings = await service.getDataSettingsForAdmin();
    const saved = settings.regions.find((item) => item.id === region.id);
    assert.equal(saved.pmtilesBytes, 1536);
    assert.equal(saved.dbBytesApproximate, true);
    assert.ok(saved.dbBytes > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('overlapping enabled region bounds are allowed to complete syncs', async () => {
  const db = createTestDb();
  const service = createDataSettingsService({
    db,
    fallbackData: {
      autoSyncEnabled: true,
      autoSyncOnStart: false,
      autoSyncIntervalHours: 24,
      pmtilesMinZoom: 13,
      pmtilesMaxZoom: 16,
      sourceLayer: 'buildings'
    }
  });

  const first = await service.saveRegion({
    name: 'Region A',
    slug: 'region-a',
    sourceType: 'extract_query',
    sourceValue: 'Region A',
    enabled: true,
    autoSyncEnabled: true,
    autoSyncIntervalHours: 24
  }, 'tester');

  const firstRun = await service.createQueuedRun(first.id, 'manual', 'tester');
  await service.markRunStarted(firstRun.id);
  await service.markRunSucceeded(firstRun.id, {
    importedFeatureCount: 10,
    activeFeatureCount: 10,
    orphanDeletedCount: 0,
    pmtilesBytes: 1024,
    bounds: {
      west: 10,
      south: 10,
      east: 20,
      north: 20
    }
  });

  const second = await service.saveRegion({
    name: 'Region B',
    slug: 'region-b',
    sourceType: 'extract_query',
    sourceValue: 'Region B',
    enabled: true,
    autoSyncEnabled: true,
    autoSyncIntervalHours: 24
  }, 'tester');

  const secondRun = await service.createQueuedRun(second.id, 'manual', 'tester');
  await service.markRunStarted(secondRun.id);

  const result = await service.markRunSucceeded(secondRun.id, {
    importedFeatureCount: 12,
    activeFeatureCount: 12,
    orphanDeletedCount: 0,
    pmtilesBytes: 2048,
    bounds: {
      west: 19.5,
      south: 19.5,
      east: 30,
      north: 30
    }
  });

  assert.equal(result.run.status, 'success');
  assert.equal(result.region.lastSyncStatus, 'idle');

  const runtimeRegions = await service.listRuntimePmtilesRegions();
  assert.equal(runtimeRegions.length, 2);
  assert.deepEqual(runtimeRegions.map((item) => item.id).sort((left, right) => left - right), [first.id, second.id]);
});

test('run lifecycle updates region status, history and nextSyncAt', async () => {
  const db = createTestDb();
  const fixedNow = new Date('2026-03-07T10:00:00.000Z');
  let currentNow = fixedNow;
  const service = createDataSettingsService({
    db,
    now: () => currentNow,
    fallbackData: {
      autoSyncEnabled: true,
      autoSyncOnStart: false,
      autoSyncIntervalHours: 24,
      pmtilesMinZoom: 13,
      pmtilesMaxZoom: 16,
      sourceLayer: 'buildings'
    }
  });

  const region = await service.saveRegion({
    name: 'Runtime Region',
    slug: 'runtime-region',
    sourceType: 'extract_query',
    sourceValue: 'Runtime Region',
    enabled: true,
    autoSyncEnabled: true,
    autoSyncOnStart: false,
    autoSyncIntervalHours: 24
  }, 'tester');

  const queuedRun = await service.createQueuedRun(region.id, 'manual', 'tester');
  assert.equal(queuedRun.status, 'queued');

  const runningRun = await service.markRunStarted(queuedRun.id);
  assert.equal(runningRun.status, 'running');

  currentNow = new Date('2026-03-07T12:30:00.000Z');
  const result = await service.markRunSucceeded(runningRun.id, {
    importedFeatureCount: 500,
    activeFeatureCount: 490,
    orphanDeletedCount: 10,
    pmtilesBytes: 4096,
    bounds: {
      west: 44,
      south: 56,
      east: 44.5,
      north: 56.5
    }
  });

  assert.equal(result.run.status, 'success');
  assert.equal(result.region.lastSyncStatus, 'idle');
  assert.equal(result.region.lastFeatureCount, 490);
  assert.equal(result.region.bounds.west, 44);
  assert.equal(result.region.lastSuccessfulSyncAt, '2026-03-07T12:30:00.000Z');
  assert.equal(result.region.nextSyncAt, '2026-03-08T12:30:00.000Z');

  const history = await service.getRecentRuns(region.id, 10);
  assert.equal(history.length, 1);
  assert.equal(history[0].importedFeatureCount, 500);
  assert.equal(history[0].activeFeatureCount, 490);
});

test('failed first sync schedules retry after interval instead of immediate rerun', async () => {
  const db = createTestDb();
  let currentNow = new Date('2026-03-07T10:00:00.000Z');
  const service = createDataSettingsService({
    db,
    now: () => currentNow,
    fallbackData: {
      autoSyncEnabled: true,
      autoSyncOnStart: false,
      autoSyncIntervalHours: 24,
      pmtilesMinZoom: 13,
      pmtilesMaxZoom: 16,
      sourceLayer: 'buildings'
    }
  });

  const region = await service.saveRegion({
    name: 'Retry Region',
    slug: 'retry-region',
    sourceType: 'extract_query',
    sourceValue: 'Retry Region',
    enabled: true,
    autoSyncEnabled: true,
    autoSyncOnStart: false,
    autoSyncIntervalHours: 24
  }, 'tester');

  assert.equal(region.nextSyncAt, '2026-03-07T10:00:00.000Z');

  const queuedRun = await service.createQueuedRun(region.id, 'manual', 'tester');
  await service.markRunStarted(queuedRun.id);

  currentNow = new Date('2026-03-07T12:30:00.000Z');
  const failed = await service.markRunFailed(queuedRun.id, 'Network timeout');
  assert.equal(failed.region.lastSyncStatus, 'failed');
  assert.equal(failed.region.nextSyncAt, '2026-03-08T12:30:00.000Z');

  currentNow = new Date('2026-03-07T13:00:00.000Z');
  const refreshed = await service.refreshRegionNextSyncAt(region.id);
  assert.equal(refreshed.nextSyncAt, '2026-03-08T12:30:00.000Z');
});

test('deleteRegion removes only orphan features and preserves shared data of other regions', async () => {
  const db = createTestDb();
  ensureContoursTable(db);
  const service = createDataSettingsService({
    db,
    fallbackData: {
      autoSyncEnabled: true,
      autoSyncOnStart: false,
      autoSyncIntervalHours: 24,
      pmtilesMinZoom: 13,
      pmtilesMaxZoom: 16,
      sourceLayer: 'buildings'
    }
  });

  const regionA = await service.saveRegion({
    name: 'Region A',
    slug: 'region-a',
    sourceType: 'extract_query',
    sourceValue: 'Region A',
    enabled: true,
    autoSyncEnabled: false,
    autoSyncIntervalHours: 0
  }, 'tester');
  const regionB = await service.saveRegion({
    name: 'Region B',
    slug: 'region-b',
    sourceType: 'extract_query',
    sourceValue: 'Region B',
    enabled: true,
    autoSyncEnabled: false,
    autoSyncIntervalHours: 0
  }, 'tester');

  db.prepare(`
    INSERT INTO osm.building_contours (
      osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run('way', 101, '{}', '{"type":"Polygon","coordinates":[]}', 1, 1, 2, 2);
  db.prepare(`
    INSERT INTO osm.building_contours (
      osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run('way', 202, '{}', '{"type":"Polygon","coordinates":[]}', 2, 2, 3, 3);

  db.prepare(`
    INSERT INTO data_region_memberships (region_id, osm_type, osm_id, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `).run(regionA.id, 'way', 101);
  db.prepare(`
    INSERT INTO data_region_memberships (region_id, osm_type, osm_id, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `).run(regionA.id, 'way', 202);
  db.prepare(`
    INSERT INTO data_region_memberships (region_id, osm_type, osm_id, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `).run(regionB.id, 'way', 202);

  const queuedRun = await service.createQueuedRun(regionA.id, 'manual', 'tester');
  await service.markRunStarted(queuedRun.id);
  await service.markRunFailed(queuedRun.id, 'Synthetic failure');

  const deleted = await service.deleteRegion(regionA.id, 'tester');
  assert.equal(deleted.region.id, regionA.id);
  assert.equal(deleted.deletedMembershipCount, 2);
  assert.equal(deleted.deletedRunCount, 1);
  assert.equal(deleted.orphanDeletedCount, 1);

  const removedRegion = await service.getRegionById(regionA.id);
  assert.equal(removedRegion, null);
  const remainingRegion = await service.getRegionById(regionB.id);
  assert.equal(remainingRegion.id, regionB.id);

  const memberships = db.prepare(`
    SELECT region_id, osm_type, osm_id
    FROM data_region_memberships
    ORDER BY region_id, osm_type, osm_id
  `).all();
  assert.deepEqual(memberships, [
    { region_id: regionB.id, osm_type: 'way', osm_id: 202 }
  ]);

  const contours = db.prepare(`
    SELECT osm_type, osm_id
    FROM osm.building_contours
    ORDER BY osm_type, osm_id
  `).all();
  assert.deepEqual(contours, [
    { osm_type: 'way', osm_id: 202 }
  ]);
});
