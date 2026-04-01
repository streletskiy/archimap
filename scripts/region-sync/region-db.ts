const fs = require('fs');
const Database = require('better-sqlite3');
const { Client } = require('pg');
const {
  closeWriteStream,
  deriveFeatureKindFromTagsJson,
  ensureDir,
  formatGeojsonFeatureLine,
  updateBounds,
  writeRowsToNdjsonFile,
  writeStreamLine
} = require('./common');
const { expandRowsWithBuildingRemainders } = require('./building-remainder');

const POSTGRES_REGION_EXPORT_BATCH_SIZE = 20000;
const BUILDING_JSON_KEY_SQL = '"building"';
const BUILDING_PART_JSON_KEY_SQL = '"building:part"';
const BUILDING_PART_ALT_JSON_KEY_SQL = '"building_part"';

function buildSqliteFeatureKindSql(columnName = 'bc.tags_json') {
  return `
    CASE
      WHEN instr(COALESCE(${columnName}, ''), '${BUILDING_JSON_KEY_SQL}') > 0 THEN 'building'
      WHEN instr(COALESCE(${columnName}, ''), '${BUILDING_PART_JSON_KEY_SQL}') > 0
        OR instr(COALESCE(${columnName}, ''), '${BUILDING_PART_ALT_JSON_KEY_SQL}') > 0 THEN 'building_part'
      ELSE 'building'
    END
  `;
}

function buildPostgresFeatureKindSql(columnName = 'bc.tags_json') {
  return `
    CASE
      WHEN POSITION('${BUILDING_JSON_KEY_SQL}' IN COALESCE(${columnName}, '')) > 0 THEN 'building'
      WHEN POSITION('${BUILDING_PART_JSON_KEY_SQL}' IN COALESCE(${columnName}, '')) > 0
        OR POSITION('${BUILDING_PART_ALT_JSON_KEY_SQL}' IN COALESCE(${columnName}, '')) > 0 THEN 'building_part'
      ELSE 'building'
    END
  `;
}

function buildSqliteRegionExportQuery({ regionPlaceholder = '?', geometrySql = 'bc.geometry_json AS geometry_json' } = {}) {
  const featureKindSql = buildSqliteFeatureKindSql('bc.tags_json');
  return `
    WITH region_rows AS (
      SELECT
        bc.osm_type,
        bc.osm_id,
        bc.tags_json,
        ${featureKindSql} AS feature_kind,
        ${geometrySql},
        bc.min_lon,
        bc.min_lat,
        bc.max_lon,
        bc.max_lat
      FROM data_region_memberships drm
      JOIN osm.building_contours bc
        ON bc.osm_type = drm.osm_type AND bc.osm_id = drm.osm_id
      WHERE drm.region_id = ${regionPlaceholder}
    ),
    buildings_with_parts AS (
      SELECT DISTINCT building.osm_type, building.osm_id
      FROM region_rows building
      JOIN region_rows part
        ON building.feature_kind = 'building'
       AND part.feature_kind = 'building_part'
       AND (part.osm_type <> building.osm_type OR part.osm_id <> building.osm_id)
       AND part.min_lon >= building.min_lon
       AND part.max_lon <= building.max_lon
       AND part.min_lat >= building.min_lat
       AND part.max_lat <= building.max_lat
    )
    SELECT
      region_rows.osm_type,
      region_rows.osm_id,
      region_rows.tags_json,
      region_rows.feature_kind,
      region_rows.geometry_json,
      region_rows.min_lon,
      region_rows.min_lat,
      region_rows.max_lon,
      region_rows.max_lat,
      CASE
        WHEN buildings_with_parts.osm_id IS NULL THEN 0
        ELSE 1
      END AS render_hide_base_when_parts
    FROM region_rows
    LEFT JOIN buildings_with_parts
      ON buildings_with_parts.osm_type = region_rows.osm_type
     AND buildings_with_parts.osm_id = region_rows.osm_id
    ORDER BY region_rows.osm_type, region_rows.osm_id
  `;
}

function buildPostgresRegionExportQuery({ regionSql = '$1', includeRemainderRows = false } = {}) {
  const featureKindSql = buildPostgresFeatureKindSql('bc.tags_json');
  const remainderCtesSql = includeRemainderRows
    ? `,
    building_remainders AS (
      SELECT
        building.osm_type,
        building.osm_id,
        building.tags_json,
        ST_Multi(
          ST_CollectionExtract(
            ST_Difference(
              ST_MakeValid(building.geom),
              ST_UnaryUnion(ST_Collect(ST_MakeValid(part.geom)))
            ),
            3
          )
        ) AS geom
      FROM region_rows building
      JOIN region_rows part
        ON building.feature_kind = 'building'
       AND part.feature_kind = 'building_part'
       AND (part.osm_type <> building.osm_type OR part.osm_id <> building.osm_id)
       AND part.min_lon >= building.min_lon
       AND part.max_lon <= building.max_lon
       AND part.min_lat >= building.min_lat
       AND part.max_lat <= building.max_lat
      GROUP BY building.osm_type, building.osm_id, building.tags_json, building.geom
    ),
    remainder_rows AS (
      SELECT
        building_remainders.osm_type,
        building_remainders.osm_id,
        building_remainders.tags_json,
        'building_remainder' AS feature_kind,
        building_remainders.geom,
        ST_XMin(building_remainders.geom) AS min_lon,
        ST_YMin(building_remainders.geom) AS min_lat,
        ST_XMax(building_remainders.geom) AS max_lon,
        ST_YMax(building_remainders.geom) AS max_lat,
        0 AS render_hide_base_when_parts
      FROM building_remainders
      WHERE building_remainders.geom IS NOT NULL
        AND NOT ST_IsEmpty(building_remainders.geom)
    )`
    : '';
  const exportRowsSql = includeRemainderRows
    ? `
    export_rows AS (
      SELECT
        region_rows.osm_type,
        region_rows.osm_id,
        region_rows.tags_json,
        region_rows.feature_kind,
        region_rows.geom,
        region_rows.min_lon,
        region_rows.min_lat,
        region_rows.max_lon,
        region_rows.max_lat,
        CASE
          WHEN buildings_with_parts.osm_id IS NULL THEN 0
          ELSE 1
        END AS render_hide_base_when_parts
      FROM region_rows
      LEFT JOIN buildings_with_parts
        ON buildings_with_parts.osm_type = region_rows.osm_type
       AND buildings_with_parts.osm_id = region_rows.osm_id

      UNION ALL

      SELECT
        remainder_rows.osm_type,
        remainder_rows.osm_id,
        remainder_rows.tags_json,
        remainder_rows.feature_kind,
        remainder_rows.geom,
        remainder_rows.min_lon,
        remainder_rows.min_lat,
        remainder_rows.max_lon,
        remainder_rows.max_lat,
        remainder_rows.render_hide_base_when_parts
      FROM remainder_rows
    )`
    : `
    export_rows AS (
      SELECT
        region_rows.osm_type,
        region_rows.osm_id,
        region_rows.tags_json,
        region_rows.feature_kind,
        region_rows.geom,
        region_rows.min_lon,
        region_rows.min_lat,
        region_rows.max_lon,
        region_rows.max_lat,
        CASE
          WHEN buildings_with_parts.osm_id IS NULL THEN 0
          ELSE 1
        END AS render_hide_base_when_parts
      FROM region_rows
      LEFT JOIN buildings_with_parts
        ON buildings_with_parts.osm_type = region_rows.osm_type
       AND buildings_with_parts.osm_id = region_rows.osm_id
    )`;
  return `
    WITH region_rows AS (
      SELECT
        bc.osm_type,
        bc.osm_id,
        bc.tags_json,
        ${featureKindSql} AS feature_kind,
        bc.geom,
        bc.min_lon,
        bc.min_lat,
        bc.max_lon,
        bc.max_lat
      FROM public.data_region_memberships drm
      JOIN osm.building_contours bc
        ON bc.osm_type = drm.osm_type AND bc.osm_id = drm.osm_id
      WHERE drm.region_id = ${regionSql}
    ),
    buildings_with_parts AS (
      SELECT DISTINCT building.osm_type, building.osm_id
      FROM region_rows building
      JOIN region_rows part
        ON building.feature_kind = 'building'
       AND part.feature_kind = 'building_part'
       AND (part.osm_type <> building.osm_type OR part.osm_id <> building.osm_id)
       AND part.min_lon >= building.min_lon
       AND part.max_lon <= building.max_lon
       AND part.min_lat >= building.min_lat
       AND part.max_lat <= building.max_lat
    )
    ${remainderCtesSql},
    ${exportRowsSql}
    SELECT
      export_rows.osm_type,
      export_rows.osm_id,
      export_rows.tags_json,
      export_rows.feature_kind,
      ST_AsGeoJSON(export_rows.geom)::text AS geometry_json,
      export_rows.min_lon,
      export_rows.min_lat,
      export_rows.max_lon,
      export_rows.max_lat,
      export_rows.render_hide_base_when_parts
    FROM export_rows
    ORDER BY
      export_rows.osm_type,
      export_rows.osm_id,
      CASE
        WHEN export_rows.feature_kind = 'building_remainder' THEN 1
        ELSE 0
      END
  `;
}

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
      const rows = await client.query(buildPostgresRegionExportQuery(), [regionId]);
      await writeRowsToNdjsonFile(
        outputPath,
        rows.rows.map((row) => ({
          osm_type: row.osm_type,
          osm_id: row.osm_id,
          tags_json: row.tags_json,
          feature_kind: row.feature_kind || deriveFeatureKindFromTagsJson(row.tags_json),
          geometry_json: row.geometry_json,
          min_lon: row.min_lon,
          min_lat: row.min_lat,
          max_lon: row.max_lon,
          max_lat: row.max_lat,
          render_hide_base_when_parts: Number(row.render_hide_base_when_parts || 0)
        }))
      );
    } finally {
      await client.end();
    }
    return;
  }

  const db = openSqliteRegionDb(archimapDbPath, osmDbPath);
  try {
    const rows = expandRowsWithBuildingRemainders(db.prepare(buildSqliteRegionExportQuery()).all(regionId));
    await writeRowsToNdjsonFile(
      outputPath,
      rows.map((row) => ({
        osm_type: row.osm_type,
        osm_id: row.osm_id,
        tags_json: row.tags_json,
        feature_kind: row.feature_kind || deriveFeatureKindFromTagsJson(row.tags_json),
        geometry_json: row.geometry_json,
        min_lon: row.min_lon,
        min_lat: row.min_lat,
        max_lon: row.max_lon,
        max_lat: row.max_lat,
        render_hide_base_when_parts: Number(row.render_hide_base_when_parts || 0)
      }))
    );
  } finally {
    db.close();
  }
}

async function exportRegionMembersToGeojsonNdjson({
  dbProvider,
  databaseUrl,
  archimapDbPath,
  osmDbPath,
  regionId,
  outputPath
}) {
  ensureDir(outputPath);
  const writer = fs.createWriteStream(outputPath, {
    encoding: 'utf8',
    highWaterMark: 1024 * 1024
  });
  let importedFeatureCount = 0;
  let bounds = null;

  async function writeRow(row) {
    await writeStreamLine(
      writer,
      formatGeojsonFeatureLine(
        row.osm_type,
        row.osm_id,
        row.geometry_json,
        row.tags_json,
        row.feature_kind,
        row.render_hide_base_when_parts
      )
    );
    importedFeatureCount += 1;
    bounds = updateBounds(bounds, row);
  }

  try {
    if (dbProvider === 'postgres') {
      const normalizedRegionId = Number(regionId);
      if (!Number.isInteger(normalizedRegionId) || normalizedRegionId <= 0) {
        throw new Error('Region export requires a positive integer regionId');
      }

      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query('BEGIN READ ONLY');
        await client.query(`
          DECLARE region_pmtiles_export_cursor NO SCROLL CURSOR FOR
          ${buildPostgresRegionExportQuery({
            regionSql: String(normalizedRegionId),
            includeRemainderRows: true
          })}
        `);

        while (true) {
          const result = await client.query(`
            FETCH FORWARD ${POSTGRES_REGION_EXPORT_BATCH_SIZE}
            FROM region_pmtiles_export_cursor
          `);
          if ((result.rowCount || 0) <= 0) {
            break;
          }
          for (const row of result.rows) {
            await writeRow(row);
          }
        }

        await client.query('CLOSE region_pmtiles_export_cursor');
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failure
        }
        throw error;
      } finally {
        await client.end();
      }
    } else {
      const db = openSqliteRegionDb(archimapDbPath, osmDbPath);
      try {
        const rows = expandRowsWithBuildingRemainders(db.prepare(buildSqliteRegionExportQuery()).all(regionId));

        for (const row of rows) {
          await writeRow(row);
        }
      } finally {
        db.close();
      }
    }
  } finally {
    await closeWriteStream(writer);
  }

  return {
    importedFeatureCount,
    bounds
  };
}

module.exports = {
  assertRegionSupportsManagedSync,
  exportRegionMembersToGeojsonNdjson,
  exportRegionMembersToNdjson,
  loadRegion,
  openSqliteRegionDb
};
