const fs = require('fs');
const { Client } = require('pg');
const {
  closeWriteStream,
  ensureDir,
  formatGeojsonFeatureLine,
  formatRenderedGeojsonFeatureLine,
  updateBounds,
  writeStreamLine
} = require('./common');

const POSTGRES_REGION_EXPORT_BATCH_SIZE = 20000;
const POSTGRES_REGION_EXPORT_PARTS_TABLE = 'region_export_parts_tmp';
const POSTGRES_REGION_EXPORT_PARTS_TABLE_REF = `pg_temp.${POSTGRES_REGION_EXPORT_PARTS_TABLE}`;
const POSTGRES_REGION_EXPORT_PARTS_GIST_INDEX = 'region_export_parts_geom_gist';
const BUILDING_JSON_KEY_SQL = '"building"';
const BUILDING_PART_JSON_KEY_SQL = '"building:part"';
const BUILDING_PART_ALT_JSON_KEY_SQL = '"building_part"';

function assertPostgresRegionSyncOptions(options: LooseRecord = {}) {
  if (String(options.dbProvider || '').trim().toLowerCase() !== 'postgres') {
    throw new Error('Managed region sync only supports DB_PROVIDER=postgres');
  }
  if (!String(options.databaseUrl || '').trim()) {
    throw new Error('DATABASE_URL is required for DB_PROVIDER=postgres');
  }
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

async function preparePostgresRegionExportPartsTable(client, regionId) {
  const normalizedRegionId = Number(regionId);
  if (!Number.isInteger(normalizedRegionId) || normalizedRegionId <= 0) {
    throw new Error('Region export requires a positive integer regionId');
  }

  await client.query(`DROP TABLE IF EXISTS ${POSTGRES_REGION_EXPORT_PARTS_TABLE}`);
  await client.query(`
    CREATE TEMP TABLE ${POSTGRES_REGION_EXPORT_PARTS_TABLE} AS
    SELECT
      bc.osm_type,
      bc.osm_id,
      ST_Multi(bc.geom) AS geom,
      bc.min_lon,
      bc.min_lat,
      bc.max_lon,
      bc.max_lat
    FROM public.data_region_memberships drm
    JOIN osm.building_contours bc
      ON bc.osm_type = drm.osm_type AND bc.osm_id = drm.osm_id
    WHERE drm.region_id = $1
      AND ${buildPostgresFeatureKindSql('bc.tags_json')} = 'building_part'
  `, [normalizedRegionId]);
  await client.query(`CREATE INDEX ${POSTGRES_REGION_EXPORT_PARTS_GIST_INDEX} ON ${POSTGRES_REGION_EXPORT_PARTS_TABLE} USING GIST (geom)`);
  await client.query(`ANALYZE ${POSTGRES_REGION_EXPORT_PARTS_TABLE}`);
}

function buildPostgresRegionExportQuery({ regionSql = '$1' } = {}) {
  const featureKindSql = buildPostgresFeatureKindSql('bc.tags_json');
  return `
    SELECT
      bc.osm_type,
      bc.osm_id,
      bc.tags_json,
      ${featureKindSql} AS feature_kind,
      ST_AsGeoJSON(bc.geom)::text AS geometry_json,
      bc.min_lon,
      bc.min_lat,
      bc.max_lon,
      bc.max_lat,
      0 AS render_hide_base_when_parts
    FROM public.data_region_memberships drm
    JOIN osm.building_contours bc
      ON bc.osm_type = drm.osm_type AND bc.osm_id = drm.osm_id
    WHERE drm.region_id = ${regionSql}
    ORDER BY bc.osm_type, bc.osm_id
  `;
}

function buildPostgresRegionBaseGeojsonExportQuery({
  regionSql = '$1',
  partsTableRef = POSTGRES_REGION_EXPORT_PARTS_TABLE_REF,
  orderBy = true
} = {}) {
  const featureKindSql = buildPostgresFeatureKindSql('bc.tags_json');
  return `
    SELECT
      rm.osm_type,
      rm.osm_id,
      rm.tags_json,
      rm.feature_kind,
      rm.geometry_json,
      rm.min_lon,
      rm.min_lat,
      rm.max_lon,
      rm.max_lat,
      CASE
        WHEN rm.feature_kind = 'building'
         AND EXISTS (
           SELECT 1
           FROM ${partsTableRef} part
           WHERE part.geom && rm.geom
             AND part.min_lon >= rm.min_lon
             AND part.max_lon <= rm.max_lon
             AND part.min_lat >= rm.min_lat
             AND part.max_lat <= rm.max_lat
         )
        THEN 1
        ELSE 0
      END AS render_hide_base_when_parts
    FROM (
      SELECT
        bc.osm_type,
        bc.osm_id,
        bc.tags_json,
        ${featureKindSql} AS feature_kind,
        bc.geom,
        ST_AsGeoJSON(bc.geom)::text AS geometry_json,
        bc.min_lon,
        bc.min_lat,
        bc.max_lon,
        bc.max_lat
      FROM public.data_region_memberships drm
      JOIN osm.building_contours bc
        ON bc.osm_type = drm.osm_type AND bc.osm_id = drm.osm_id
      WHERE drm.region_id = ${regionSql}
    ) rm
    WHERE rm.feature_kind IN ('building', 'building_part')
    ${orderBy ? 'ORDER BY rm.osm_type, rm.osm_id' : ''}
  `;
}

function buildPostgresRegionRemainderGeojsonExportQuery({
  regionSql = '$1',
  partsTableRef = POSTGRES_REGION_EXPORT_PARTS_TABLE_REF,
  orderBy = true
} = {}) {
  const featureKindSql = buildPostgresFeatureKindSql('bc.tags_json');
  return `
    SELECT
      b.osm_type,
      b.osm_id,
      b.tags_json,
      'building_remainder'::text AS feature_kind,
      ST_AsGeoJSON(derived.remainder_geom)::text AS geometry_json,
      derived.min_lon,
      derived.min_lat,
      derived.max_lon,
      derived.max_lat,
      0 AS render_hide_base_when_parts
    FROM (
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
    ) b
    JOIN LATERAL (
      SELECT
        remainder_geom,
        ST_XMin(remainder_geom) AS min_lon,
        ST_YMin(remainder_geom) AS min_lat,
        ST_XMax(remainder_geom) AS max_lon,
        ST_YMax(remainder_geom) AS max_lat
      FROM (
        SELECT ST_Multi(ST_CollectionExtract(ST_Difference(b.geom, part_union.geom), 3)) AS remainder_geom
        FROM (
          SELECT ST_UnaryUnion(ST_Collect(part.geom)) AS geom
          FROM ${partsTableRef} part
          WHERE part.geom && b.geom
            AND part.min_lon >= b.min_lon
            AND part.max_lon <= b.max_lon
            AND part.min_lat >= b.min_lat
            AND part.max_lat <= b.max_lat
        ) part_union
        WHERE part_union.geom IS NOT NULL
      ) remainder
      WHERE remainder.remainder_geom IS NOT NULL
        AND NOT ST_IsEmpty(remainder.remainder_geom)
    ) derived ON TRUE
    WHERE b.feature_kind = 'building'
    ${orderBy ? 'ORDER BY b.osm_type, b.osm_id' : ''}
  `;
}

function buildPostgresRegionGeojsonExportQuery({
  regionSql = '$1',
  partsTableRef = POSTGRES_REGION_EXPORT_PARTS_TABLE_REF
} = {}) {
  return `
    ${buildPostgresRegionBaseGeojsonExportQuery({ regionSql, partsTableRef, orderBy: false })}
    UNION ALL
    ${buildPostgresRegionRemainderGeojsonExportQuery({ regionSql, partsTableRef, orderBy: false })}
  `;
}

function buildPostgresRegionRenderFeatureExportQuery({ regionSql = '$1' } = {}) {
  return `
    SELECT
      rf.osm_type,
      rf.osm_id,
      rf.feature_kind,
      ST_AsGeoJSON(rf.geom)::text AS geometry_json,
      rf.render_height_m,
      rf.render_min_height_m,
      rf.render_hide_base_when_parts,
      rf.min_lon,
      rf.min_lat,
      rf.max_lon,
      rf.max_lat
    FROM osm.region_render_features rf
    WHERE rf.region_id = ${regionSql}
    ORDER BY
      rf.osm_type,
      rf.osm_id,
      CASE
        WHEN rf.feature_kind = 'building_remainder' THEN 1
        ELSE 0
      END
  `;
}

function normalizeRegionRow(row) {
  if (!row) return null;
  const extractSource = String(row.extract_source || '').trim();
  const extractId = String(row.extract_id || '').trim();
  const extractResolutionStatus =
    String(row.extract_resolution_status || (extractSource && extractId ? 'resolved' : 'needs_resolution'))
      .trim()
      .toLowerCase() || 'needs_resolution';
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
    bounds:
      row.bounds_west == null
        ? null
        : {
            west: Number(row.bounds_west),
            south: Number(row.bounds_south),
            east: Number(row.bounds_east),
            north: Number(row.bounds_north)
          },
    regionKind: (() => {
      const raw = String(row.region_kind || '')
        .trim()
        .toLowerCase();
      return ['standalone', 'country_aggregate', 'subregion'].includes(raw) ? raw : 'standalone';
    })(),
    parentRegionId: row.parent_region_id == null ? null : Number(row.parent_region_id) || null,
    orderInParent: row.order_in_parent == null ? null : Number(row.order_in_parent)
  };
}

function assertRegionSupportsManagedSync(region) {
  if (!region) {
    throw new Error('Region not found');
  }
  if (region.regionKind === 'country_aggregate') {
    return;
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

async function withPostgresClient(databaseUrl, work) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function getRegionFromPostgres({ databaseUrl }, regionId) {
  return withPostgresClient(databaseUrl, async (client) => {
    const result = await client.query(
      `
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
        bounds_north,
        region_kind,
        parent_region_id,
        order_in_parent
      FROM public.data_sync_regions
      WHERE id = $1
      LIMIT 1
    `,
      [Number(regionId)]
    );
    return normalizeRegionRow(result.rows[0]);
  });
}

async function loadSubregions(options, parentRegionId) {
  assertPostgresRegionSyncOptions(options);
  const parentId = Number(parentRegionId);
  if (!Number.isInteger(parentId) || parentId <= 0) return [];

  return withPostgresClient(options.databaseUrl, async (client) => {
    const result = await client.query(
      `
      SELECT
        id, slug, name, source_type, source_value, extract_source, extract_id,
        extract_label, extract_resolution_status, extract_resolution_error,
        enabled, auto_sync_enabled, auto_sync_on_start, auto_sync_interval_hours,
        pmtiles_min_zoom, pmtiles_max_zoom, source_layer,
        bounds_west, bounds_south, bounds_east, bounds_north,
        region_kind, parent_region_id, order_in_parent
      FROM public.data_sync_regions
      WHERE parent_region_id = $1
      ORDER BY COALESCE(order_in_parent, 0), id
    `,
      [parentId]
    );
    return (result.rows || []).map(normalizeRegionRow).filter(Boolean);
  });
}

async function updateRegionPostSync(options, regionId, summary) {
  assertPostgresRegionSyncOptions(options);
  const id = Number(regionId);
  if (!Number.isInteger(id) || id <= 0) return;
  const nowIso = new Date().toISOString();
  const bounds = summary?.bounds || null;
  const featureCount = Number.isFinite(Number(summary?.activeFeatureCount))
    ? Number(summary.activeFeatureCount)
    : Number.isFinite(Number(summary?.importedFeatureCount))
      ? Number(summary.importedFeatureCount)
      : null;

  await withPostgresClient(options.databaseUrl, async (client) => {
    await client.query(
      `
      UPDATE public.data_sync_regions
      SET
        last_sync_status = 'idle',
        last_sync_finished_at = $2,
        last_sync_error = NULL,
        last_successful_sync_at = $2,
        bounds_west = $3,
        bounds_south = $4,
        bounds_east = $5,
        bounds_north = $6,
        last_feature_count = $7,
        updated_at = NOW()
      WHERE id = $1
    `,
      [id, nowIso, bounds?.west ?? null, bounds?.south ?? null, bounds?.east ?? null, bounds?.north ?? null, featureCount]
    );
  });
}

async function loadRegion(options, regionId) {
  assertPostgresRegionSyncOptions(options);
  return getRegionFromPostgres(options, regionId);
}

async function streamPostgresCursorRows({
  client,
  query,
  params = [],
  cursorName,
  batchSize = POSTGRES_REGION_EXPORT_BATCH_SIZE,
  onRows
}) {
  const normalizedBatchSize = Math.max(1, Math.trunc(Number(batchSize) || POSTGRES_REGION_EXPORT_BATCH_SIZE));
  const normalizedCursorName = String(cursorName || '').trim();
  if (!normalizedCursorName) {
    throw new Error('Cursor name is required for streaming PostgreSQL query rows');
  }
  if (typeof onRows !== 'function') {
    throw new Error('onRows callback is required for streaming PostgreSQL query rows');
  }

  await client.query('BEGIN READ ONLY');
  try {
    await client.query(`DECLARE ${normalizedCursorName} NO SCROLL CURSOR FOR ${query}`, params);
    while (true) {
      const result = await client.query(`
        FETCH FORWARD ${normalizedBatchSize}
        FROM ${normalizedCursorName}
      `);
      if ((result.rowCount || 0) <= 0) {
        break;
      }
      await onRows(result.rows || []);
    }
    await client.query(`CLOSE ${normalizedCursorName}`);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw error;
  }
}

async function exportRegionMembersToNdjson({ dbProvider, databaseUrl, regionId, outputPath }) {
  assertPostgresRegionSyncOptions({ dbProvider, databaseUrl });
  ensureDir(outputPath);
  const writer = fs.createWriteStream(outputPath, {
    encoding: 'utf8',
    highWaterMark: 1024 * 1024
  });
  try {
    await withPostgresClient(databaseUrl, async (client) => {
      const normalizedRegionId = Number(regionId);
      if (!Number.isInteger(normalizedRegionId) || normalizedRegionId <= 0) {
        throw new Error('Region export requires a positive integer regionId');
      }
      await preparePostgresRegionExportPartsTable(client, normalizedRegionId);
      try {
        await streamPostgresCursorRows({
          client,
          query: buildPostgresRegionGeojsonExportQuery({ regionSql: String(normalizedRegionId) }),
          params: [],
          cursorName: 'region_members_ndjson_export_cursor',
          onRows: async (rows) => {
            for (const row of rows) {
              await writeStreamLine(writer, `${JSON.stringify(row)}\n`);
            }
          }
        });
      } finally {
        try {
          await client.query(`DROP TABLE IF EXISTS ${POSTGRES_REGION_EXPORT_PARTS_TABLE}`);
        } catch {
          // ignore temp table cleanup failures
        }
      }
    });
  } finally {
    await closeWriteStream(writer);
  }
}

async function exportRegionMembersToGeojsonNdjson({ dbProvider, databaseUrl, regionId, outputPath }) {
  assertPostgresRegionSyncOptions({ dbProvider, databaseUrl });
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
    await withPostgresClient(databaseUrl, async (client) => {
      const normalizedRegionId = Number(regionId);
      if (!Number.isInteger(normalizedRegionId) || normalizedRegionId <= 0) {
        throw new Error('Region export requires a positive integer regionId');
      }
      await preparePostgresRegionExportPartsTable(client, normalizedRegionId);
      try {
        await streamPostgresCursorRows({
          client,
          query: buildPostgresRegionBaseGeojsonExportQuery({ regionSql: String(normalizedRegionId) }),
          params: [],
          cursorName: 'region_members_base_geojson_export_cursor',
          onRows: async (rows) => {
            for (const row of rows) {
              await writeRow(row);
            }
          }
        });
        await streamPostgresCursorRows({
          client,
          query: buildPostgresRegionRemainderGeojsonExportQuery({ regionSql: String(normalizedRegionId) }),
          params: [],
          cursorName: 'region_members_remainder_geojson_export_cursor',
          onRows: async (rows) => {
            for (const row of rows) {
              await writeRow(row);
            }
          }
        });
      } finally {
        try {
          await client.query(`DROP TABLE IF EXISTS ${POSTGRES_REGION_EXPORT_PARTS_TABLE}`);
        } catch {
          // ignore temp table cleanup failures
        }
      }
    });
  } finally {
    await closeWriteStream(writer);
  }

  return {
    importedFeatureCount,
    bounds
  };
}

async function exportRegionRenderFeaturesToGeojsonNdjson({ dbProvider, databaseUrl, regionId, outputPath }) {
  assertPostgresRegionSyncOptions({ dbProvider, databaseUrl });

  return withPostgresClient(databaseUrl, async (client) => {
    const cacheTableResult = await client.query(`SELECT to_regclass('osm.region_render_features') AS regclass`);
    if (!cacheTableResult.rows[0]?.regclass) {
      return exportRegionMembersToGeojsonNdjson({
        dbProvider,
        databaseUrl,
        regionId,
        outputPath
      });
    }

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
        formatRenderedGeojsonFeatureLine(
          row.osm_type,
          row.osm_id,
          row.geometry_json,
          row.feature_kind,
          row.render_height_m,
          row.render_min_height_m,
          row.render_hide_base_when_parts
        )
      );
      importedFeatureCount += 1;
      bounds = updateBounds(bounds, row);
    }

    try {
      const normalizedRegionId = Number(regionId);
      if (!Number.isInteger(normalizedRegionId) || normalizedRegionId <= 0) {
        throw new Error('Region export requires a positive integer regionId');
      }
      await streamPostgresCursorRows({
        client,
        query: buildPostgresRegionRenderFeatureExportQuery({
          regionSql: String(normalizedRegionId)
        }),
        params: [],
        cursorName: 'region_render_export_cursor',
        onRows: async (rows) => {
          for (const row of rows) {
            await writeRow(row);
          }
        }
      });
    } finally {
      await closeWriteStream(writer);
    }

    if (importedFeatureCount > 0) {
      return {
        importedFeatureCount,
        bounds
      };
    }

    return exportRegionMembersToGeojsonNdjson({
      dbProvider,
      databaseUrl,
      regionId,
      outputPath
    });
  });
}

module.exports = {
  assertRegionSupportsManagedSync,
  buildPostgresRegionExportQuery,
  buildPostgresRegionBaseGeojsonExportQuery,
  buildPostgresRegionGeojsonExportQuery,
  buildPostgresRegionRemainderGeojsonExportQuery,
  exportRegionMembersToGeojsonNdjson,
  exportRegionRenderFeaturesToGeojsonNdjson,
  exportRegionMembersToNdjson,
  loadRegion,
  loadSubregions,
  updateRegionPostSync
};
