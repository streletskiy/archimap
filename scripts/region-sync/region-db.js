const Database = require('better-sqlite3');
const { Client } = require('pg');
const { ensureDir, writeRowsToNdjsonFile } = require('./common');

function openSqliteRegionDb(archimapDbPath, osmDbPath) {
  ensureDir(archimapDbPath);
  ensureDir(osmDbPath);
  const db = new Database(archimapDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.prepare('ATTACH DATABASE ? AS osm').run(osmDbPath);
  db.exec('PRAGMA osm.journal_mode = WAL;');
  db.exec('PRAGMA osm.synchronous = NORMAL;');
  return db;
}

function normalizeRegionRow(row) {
  if (!row) return null;
  const extractSource = String(row.extract_source || '').trim();
  const extractId = String(row.extract_id || '').trim();
  const extractResolutionStatus = String(
    row.extract_resolution_status || (extractSource && extractId ? 'resolved' : 'needs_resolution')
  ).trim().toLowerCase() || 'needs_resolution';
  return {
    id: Number(row.id),
    slug: String(row.slug || ''),
    name: String(row.name || ''),
    sourceType: String(row.source_type || 'extract'),
    searchQuery: String(row.source_value || ''),
    extractSource,
    extractId,
    extractLabel: row.extract_label ? String(row.extract_label) : null,
    extractResolutionStatus,
    extractResolutionError: row.extract_resolution_error ? String(row.extract_resolution_error) : null,
    canSync: Boolean(extractSource && extractId && extractResolutionStatus === 'resolved'),
    enabled: Number(row.enabled || 0) > 0,
    autoSyncEnabled: Number(row.auto_sync_enabled || 0) > 0,
    autoSyncOnStart: Number(row.auto_sync_on_start || 0) > 0,
    autoSyncIntervalHours: Number(row.auto_sync_interval_hours || 0),
    pmtilesMinZoom: Number(row.pmtiles_min_zoom || 13),
    pmtilesMaxZoom: Number(row.pmtiles_max_zoom || 16),
    sourceLayer: String(row.source_layer || 'buildings'),
    bounds: row.bounds_west == null ? null : {
      west: Number(row.bounds_west),
      south: Number(row.bounds_south),
      east: Number(row.bounds_east),
      north: Number(row.bounds_north)
    }
  };
}

function assertRegionSupportsManagedSync(region) {
  if (!region) {
    throw new Error('Region not found');
  }
  if (region.sourceType !== 'extract') {
    throw new Error('Only sourceType=extract is supported by managed region sync');
  }
  if (!region.extractId || !region.extractSource) {
    throw new Error(region.extractResolutionError || 'Region canonical extract is empty');
  }
  if (region.extractResolutionStatus !== 'resolved') {
    throw new Error(region.extractResolutionError || 'Region canonical extract requires manual resolution');
  }
}

function getRegionFromSqlite({ archimapDbPath, osmDbPath }, regionId) {
  const db = openSqliteRegionDb(archimapDbPath, osmDbPath);
  try {
    const row = db.prepare(`
      SELECT
        id,
        slug,
        name,
        source_type,
        source_value,
        extract_source,
        extract_id,
        extract_label,
        extract_resolution_status,
        extract_resolution_error,
        enabled,
        auto_sync_enabled,
        auto_sync_on_start,
        auto_sync_interval_hours,
        pmtiles_min_zoom,
        pmtiles_max_zoom,
        source_layer,
        bounds_west,
        bounds_south,
        bounds_east,
        bounds_north
      FROM data_sync_regions
      WHERE id = ?
      LIMIT 1
    `).get(Number(regionId));
    return normalizeRegionRow(row);
  } finally {
    db.close();
  }
}

async function getRegionFromPostgres({ databaseUrl }, regionId) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT
        id,
        slug,
        name,
        source_type,
        source_value,
        extract_source,
        extract_id,
        extract_label,
        extract_resolution_status,
        extract_resolution_error,
        enabled,
        auto_sync_enabled,
        auto_sync_on_start,
        auto_sync_interval_hours,
        pmtiles_min_zoom,
        pmtiles_max_zoom,
        source_layer,
        bounds_west,
        bounds_south,
        bounds_east,
        bounds_north
      FROM public.data_sync_regions
      WHERE id = $1
      LIMIT 1
    `, [Number(regionId)]);
    return normalizeRegionRow(result.rows[0]);
  } finally {
    await client.end();
  }
}

async function loadRegion(options, regionId) {
  if (options.dbProvider === 'postgres') {
    if (!options.databaseUrl) {
      throw new Error('DATABASE_URL is required for DB_PROVIDER=postgres');
    }
    return getRegionFromPostgres(options, regionId);
  }
  return getRegionFromSqlite(options, regionId);
}

async function exportRegionMembersToNdjson({
  dbProvider,
  databaseUrl,
  archimapDbPath,
  osmDbPath,
  regionId,
  outputPath
}) {
  if (dbProvider === 'postgres') {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const rows = await client.query(`
        SELECT bc.osm_type, bc.osm_id, bc.geometry_json, bc.min_lon, bc.min_lat, bc.max_lon, bc.max_lat
        FROM public.data_region_memberships drm
        JOIN osm.building_contours bc
          ON bc.osm_type = drm.osm_type AND bc.osm_id = drm.osm_id
        WHERE drm.region_id = $1
        ORDER BY bc.osm_type, bc.osm_id
      `, [regionId]);
      await writeRowsToNdjsonFile(
        outputPath,
        rows.rows.map((row) => ({
          osm_type: row.osm_type,
          osm_id: row.osm_id,
          geometry_json: row.geometry_json,
          min_lon: row.min_lon,
          min_lat: row.min_lat,
          max_lon: row.max_lon,
          max_lat: row.max_lat
        }))
      );
    } finally {
      await client.end();
    }
    return;
  }

  const db = openSqliteRegionDb(archimapDbPath, osmDbPath);
  try {
    const rows = db.prepare(`
      SELECT bc.osm_type, bc.osm_id, bc.geometry_json, bc.min_lon, bc.min_lat, bc.max_lon, bc.max_lat
      FROM data_region_memberships drm
      JOIN osm.building_contours bc
        ON bc.osm_type = drm.osm_type AND bc.osm_id = drm.osm_id
      WHERE drm.region_id = ?
      ORDER BY bc.osm_type, bc.osm_id
    `).all(regionId);
    await writeRowsToNdjsonFile(
      outputPath,
      rows.map((row) => ({
        osm_type: row.osm_type,
        osm_id: row.osm_id,
        geometry_json: row.geometry_json,
        min_lon: row.min_lon,
        min_lat: row.min_lat,
        max_lon: row.max_lon,
        max_lat: row.max_lat
      }))
    );
  } finally {
    db.close();
  }
}

module.exports = {
  assertRegionSupportsManagedSync,
  exportRegionMembersToNdjson,
  loadRegion,
  openSqliteRegionDb
};
