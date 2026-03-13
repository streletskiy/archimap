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

function createMockExtractResolver(fixtures = {}) {
  const exact = fixtures.exact || {};

  function buildDefaultCandidate(query, source = 'mock') {
    const extractSource = String(source || 'mock').trim() || 'mock';
    const extractId = String(query || '').trim();
    return extractId
      ? {
        extractSource: extractSource === 'any' ? 'mock' : extractSource,
        extractId,
        extractLabel: extractId
      }
      : null;
  }

  function lookupExact(query, source = 'any') {
    const sourceKey = String(source || 'any').trim() || 'any';
    const queryKey = String(query || '').trim();
    return exact[`${sourceKey}:${queryKey}`] ?? exact[queryKey] ?? null;
  }

  return {
    async searchExtractCandidates(query, options = {}) {
      const candidate = buildDefaultCandidate(query, options.source || 'mock');
      return {
        query: String(query || '').trim(),
        items: candidate ? [candidate] : []
      };
    },
    async resolveExactExtract(query, options = {}) {
      const fixture = lookupExact(query, options.source);
      if (fixture) {
        return fixture;
      }
      const candidate = buildDefaultCandidate(query, options.source || 'mock');
      if (!candidate) {
        return {
          candidate: null,
          errorCode: 'not_found',
          message: 'Extract not found'
        };
      }
      return {
        candidate,
        errorCode: null,
        message: null
      };
    }
  };
}

function createService(options = {}) {
  return createDataSettingsService({
    db: options.db,
    dataDir: options.dataDir,
    now: options.now,
    extractResolver: options.extractResolver || createMockExtractResolver(),
    fallbackData: options.fallbackData || {
      autoSyncEnabled: true,
      autoSyncOnStart: false,
      autoSyncIntervalHours: 24,
      pmtilesMinZoom: 13,
      pmtilesMaxZoom: 16,
      sourceLayer: 'buildings'
    }
  });
}

function buildRegionInput(input = {}) {
  const name = String(input.name || '').trim() || 'Test Region';
  const slug = String(input.slug || '').trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const extractId = String(input.extractId || slug).trim() || slug;
  return {
    ...(input.id ? { id: input.id } : {}),
    name,
    slug,
    sourceType: 'extract',
    searchQuery: String(input.searchQuery || name).trim() || name,
    extractSource: String(input.extractSource || 'mock').trim() || 'mock',
    extractId,
    extractLabel: String(input.extractLabel || name).trim() || name,
    enabled: input.enabled ?? true,
    autoSyncEnabled: input.autoSyncEnabled ?? true,
    autoSyncOnStart: input.autoSyncOnStart ?? false,
    autoSyncIntervalHours: input.autoSyncIntervalHours ?? 24,
    pmtilesMinZoom: input.pmtilesMinZoom ?? 13,
    pmtilesMaxZoom: input.pmtilesMaxZoom ?? 16,
    sourceLayer: String(input.sourceLayer || 'buildings').trim() || 'buildings'
  };
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
  const service = createService({
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
  const service = createService({
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
  const service = createService({
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
  const service = createService({
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

  const created = await service.saveRegion(buildRegionInput({
    name: 'Original Region',
    slug: 'original-region',
    extractId: 'original-region',
    autoSyncEnabled: true,
    autoSyncIntervalHours: 24
  }), 'tester');

  const renamed = await service.saveRegion(buildRegionInput({
    id: created.id,
    name: 'Renamed Region',
    slug: 'renamed-region',
    searchQuery: 'Original Region',
    extractId: 'original-region',
    autoSyncEnabled: true,
    autoSyncIntervalHours: 24
  }), 'tester');

  assert.equal(renamed.id, created.id);
  assert.equal(renamed.name, 'Renamed Region');
  assert.equal(renamed.slug, 'renamed-region');
});

test('saveRegion rejects free-form region payload without canonical extract', async () => {
  const db = createTestDb();
  const service = createService({ db });

  await assert.rejects(
    service.saveRegion({
      name: 'Legacy Query Only',
      slug: 'legacy-query-only',
      sourceType: 'extract',
      searchQuery: 'Moscow City',
      enabled: true,
      autoSyncEnabled: true,
      autoSyncIntervalHours: 24
    }, 'tester'),
    /canonical extract/i
  );
});

test('saveRegion rejects legacy sourceValue/sourceType aliases', async () => {
  const db = createTestDb();
  const service = createService({ db });

  await assert.rejects(
    service.saveRegion({
      name: 'Legacy Source Value',
      slug: 'legacy-source-value',
      sourceType: 'extract',
      sourceValue: 'Moscow City',
      extractSource: 'mock',
      extractId: 'legacy-source-value',
      extractLabel: 'Legacy Source Value',
      enabled: true,
      autoSyncEnabled: true,
      autoSyncIntervalHours: 24,
      pmtilesMinZoom: 13,
      pmtilesMaxZoom: 16,
      sourceLayer: 'buildings'
    }, 'tester'),
    /sourceValue/i
  );

  await assert.rejects(
    service.saveRegion({
      name: 'Legacy Source Type',
      slug: 'legacy-source-type',
      sourceType: 'extract_query',
      searchQuery: 'Moscow City',
      extractSource: 'mock',
      extractId: 'legacy-source-type',
      extractLabel: 'Legacy Source Type',
      enabled: true,
      autoSyncEnabled: true,
      autoSyncIntervalHours: 24,
      pmtilesMinZoom: 13,
      pmtilesMaxZoom: 16,
      sourceLayer: 'buildings'
    }, 'tester'),
    /extract_query/i
  );
});

test('legacy unresolved regions stay unresolved until manual extract selection', async () => {
  const db = createTestDb();
  const service = createService({
    db,
    extractResolver: createMockExtractResolver({
      exact: {
        'legacy-exact': {
          candidate: {
            extractSource: 'osmfr',
            extractId: 'osmfr_region_exact',
            extractLabel: 'Exact Region'
          },
          errorCode: null,
          message: null
        }
      }
    })
  });

  db.prepare(`
    INSERT INTO data_sync_regions (
      slug,
      name,
      source_type,
      source_value,
      extract_resolution_status,
      enabled,
      auto_sync_enabled,
      auto_sync_interval_hours,
      pmtiles_min_zoom,
      pmtiles_max_zoom,
      source_layer,
      last_sync_status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, 1, 1, 24, 13, 16, 'buildings', 'idle', datetime('now'), datetime('now'))
  `).run('legacy-exact', 'Legacy Exact', 'extract', 'legacy-exact', 'needs_resolution');

  const adminSettings = await service.getDataSettingsForAdmin();
  const legacy = adminSettings.regions.find((item) => item.slug === 'legacy-exact');
  assert.ok(legacy);
  assert.equal(legacy.extractResolutionStatus, 'needs_resolution');
  assert.equal(legacy.extractSource, '');
  assert.equal(legacy.extractId, '');
  assert.equal(legacy.canSync, false);

  const stored = db.prepare(`
    SELECT extract_source, extract_id, extract_resolution_status
    FROM data_sync_regions
    WHERE slug = ?
    LIMIT 1
  `).get('legacy-exact');
  assert.equal(stored.extract_source, null);
  assert.equal(stored.extract_id, null);
  assert.equal(stored.extract_resolution_status, 'needs_resolution');

  await assert.rejects(
    service.createQueuedRun(legacy.id, 'manual', 'tester'),
    /manual canonical extract selection/i
  );
});

test('saveRegion allows first canonical extract selection for already synced legacy region', async () => {
  const db = createTestDb();
  const service = createService({
    db,
    extractResolver: createMockExtractResolver({
      exact: {
        'geofabrik:geofabrik_antarctica': {
          candidate: {
            extractSource: 'geofabrik',
            extractId: 'geofabrik_antarctica',
            extractLabel: 'antarctica'
          },
          errorCode: null,
          message: null
        }
      }
    })
  });

  db.prepare(`
    INSERT INTO data_sync_regions (
      slug,
      name,
      source_type,
      source_value,
      extract_resolution_status,
      enabled,
      auto_sync_enabled,
      auto_sync_on_start,
      auto_sync_interval_hours,
      pmtiles_min_zoom,
      pmtiles_max_zoom,
      source_layer,
      last_sync_status,
      last_successful_sync_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, 'extract', ?, 'needs_resolution', 1, 0, 0, 0, 12, 15, 'buildings', 'idle', datetime('now'), datetime('now'), datetime('now'))
  `).run('legacy-synced-region', 'Legacy Synced Region', 'Antarctica');

  const inserted = db.prepare(`
    SELECT id
    FROM data_sync_regions
    WHERE slug = ?
    LIMIT 1
  `).get('legacy-synced-region');
  assert.ok(inserted?.id);

  db.prepare(`
    INSERT INTO data_region_memberships (
      region_id,
      osm_type,
      osm_id,
      created_at,
      updated_at
    )
    VALUES (?, 'way', 101, datetime('now'), datetime('now'))
  `).run(inserted.id);

  const saved = await service.saveRegion({
    id: inserted.id,
    name: 'Legacy Synced Region',
    slug: 'legacy-synced-region',
    sourceType: 'extract',
    searchQuery: 'Antarctica',
    extractSource: 'geofabrik',
    extractId: 'geofabrik_antarctica',
    extractLabel: 'antarctica',
    enabled: true,
    autoSyncEnabled: false,
    autoSyncOnStart: false,
    autoSyncIntervalHours: 0,
    pmtilesMinZoom: 12,
    pmtilesMaxZoom: 15,
    sourceLayer: 'buildings'
  }, 'tester');

  assert.equal(saved.extractResolutionStatus, 'resolved');
  assert.equal(saved.extractSource, 'geofabrik');
  assert.equal(saved.extractId, 'geofabrik_antarctica');
  assert.equal(saved.lastSuccessfulSyncAt !== null, true);
});

test('getDataSettingsForAdmin includes PMTiles size from disk and DB storage bytes for region', async () => {
  const db = createTestDb();
  ensureContoursTable(db);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-region-storage-'));
  const service = createService({
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
    const region = await service.saveRegion(buildRegionInput({
      name: 'Storage Region',
      slug: 'storage-region',
      extractId: 'storage-region',
      autoSyncEnabled: true,
      autoSyncIntervalHours: 24
    }), 'tester');

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
  const service = createService({
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

  const first = await service.saveRegion(buildRegionInput({
    name: 'Region A',
    slug: 'region-a',
    extractId: 'region-a',
    autoSyncEnabled: true,
    autoSyncIntervalHours: 24
  }), 'tester');

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

  const second = await service.saveRegion(buildRegionInput({
    name: 'Region B',
    slug: 'region-b',
    extractId: 'region-b',
    autoSyncEnabled: true,
    autoSyncIntervalHours: 24
  }), 'tester');

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
  const service = createService({
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

  const region = await service.saveRegion(buildRegionInput({
    name: 'Runtime Region',
    slug: 'runtime-region',
    extractId: 'runtime-region',
    autoSyncEnabled: true,
    autoSyncOnStart: false,
    autoSyncIntervalHours: 24
  }), 'tester');

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
  const service = createService({
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

  const region = await service.saveRegion(buildRegionInput({
    name: 'Retry Region',
    slug: 'retry-region',
    extractId: 'retry-region',
    autoSyncEnabled: true,
    autoSyncOnStart: false,
    autoSyncIntervalHours: 24
  }), 'tester');

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
  const service = createService({
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

  const regionA = await service.saveRegion(buildRegionInput({
    name: 'Region A',
    slug: 'region-a',
    extractId: 'region-a',
    autoSyncEnabled: false,
    autoSyncIntervalHours: 0
  }), 'tester');
  const regionB = await service.saveRegion(buildRegionInput({
    name: 'Region B',
    slug: 'region-b',
    extractId: 'region-b',
    autoSyncEnabled: false,
    autoSyncIntervalHours: 0
  }), 'tester');

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
