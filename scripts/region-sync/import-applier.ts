const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { Client } = require('pg');
const { from: copyFrom } = require('pg-copy-streams');
const { resolveRegionPmtilesPath } = require('../../src/lib/server/services/data-settings.service');
const { buildPmtilesSwap, readImportRows, readRenderedGeojsonFeatures } = require('./common');
const { computeGeometryBounds } = require('./pmtiles-builder');

const DEFAULT_IMPORT_APPLY_BATCH_SIZE = 1000;
const MAX_IMPORT_APPLY_BATCH_SIZE = 8000;
const APPLY_ROWS_PROGRESS_MAX = 70;
const APPLY_COUNT_NEW_PROGRESS = 72;
const APPLY_UPSERT_PROGRESS = 75;
const APPLY_MEMBERSHIPS_PROGRESS = 90;
const APPLY_STALE_MEMBERSHIPS_PROGRESS = 94;
const APPLY_ORPHAN_CLEANUP_PROGRESS = 98;
const APPLY_SUMMARY_REFRESH_PROGRESS = 99;
const APPLY_COMPLETE_PROGRESS = 100;
const POSTGRES_RENDER_CACHE_BATCH_SIZE = 250;

function resolveImportApplyBatchSize(env: LooseRecord = process.env) {
  const rawValue = Number(env.REGION_SYNC_IMPORT_APPLY_BATCH_SIZE);
  if (!Number.isInteger(rawValue) || rawValue <= 0) {
    return DEFAULT_IMPORT_APPLY_BATCH_SIZE;
  }
  return Math.min(rawValue, MAX_IMPORT_APPLY_BATCH_SIZE);
}

function escapePostgresCopyTextValue(value) {
  if (value == null) return '\\N';
  return String(value).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function buildPostgresCopyTextLine(row) {
  return (
    [
      escapePostgresCopyTextValue(row.osm_type),
      escapePostgresCopyTextValue(row.osm_id),
      escapePostgresCopyTextValue(row.tags_json),
      escapePostgresCopyTextValue(row.geometry_wkb_hex),
      escapePostgresCopyTextValue(row.min_lon),
      escapePostgresCopyTextValue(row.min_lat),
      escapePostgresCopyTextValue(row.max_lon),
      escapePostgresCopyTextValue(row.max_lat)
    ].join('\t') + '\n'
  );
}

function computePostgresContourSummaryTotal(previousTotal, insertedCount, orphanDeletedCount) {
  return Math.max(
    0,
    Math.trunc(Number(previousTotal) || 0) +
      Math.trunc(Number(insertedCount) || 0) -
      Math.trunc(Number(orphanDeletedCount) || 0)
  );
}

function quotePostgresIdentifier(value) {
  const text = String(value || '').trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(text)) {
    throw new Error(`Invalid PostgreSQL identifier: ${text || '<empty>'}`);
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function buildStageTableRef(stageSchema, stageTable) {
  return `${quotePostgresIdentifier(stageSchema)}.${quotePostgresIdentifier(stageTable)}`;
}

async function preparePostgresStageApplyOrdering(client, stageSchema, stageTable) {
  const stageRef = buildStageTableRef(stageSchema, stageTable);
  await client.query(`CREATE INDEX IF NOT EXISTS osm_key_idx ON ${stageRef} (osm_type_code, osm_id)`);
  await client.query(`ANALYZE ${stageRef}`);
}

function buildStageOsmTypeSql(columnName = 'src.osm_type_code') {
  return `
    CASE ${columnName}
      WHEN 'W' THEN 'way'
      WHEN 'R' THEN 'relation'
      WHEN 'N' THEN 'node'
      ELSE 'unknown'
    END
  `;
}

function normalizeProgress(progress) {
  const numericProgress = Number(progress);
  if (!Number.isFinite(numericProgress)) return null;
  return Math.max(0, Math.min(100, Math.round(numericProgress)));
}

function normalizeTotalFeatureCount(totalFeatureCount) {
  const numericTotal = Number(totalFeatureCount);
  if (!Number.isInteger(numericTotal) || numericTotal <= 0) return null;
  return numericTotal;
}

function shouldRefreshPostgresRenderCache(env = process.env) {
  return (
    String(env.REGION_SYNC_RENDER_CACHE_REFRESH || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

async function refreshPostgresRegionRenderCache(client, { region, renderGeojsonPath }) {
  const normalizedPath = String(renderGeojsonPath || '').trim();
  const normalizedRegionId = Number(region?.id || 0);
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return { refreshed: false, insertedCount: 0 };
  }
  if (!Number.isInteger(normalizedRegionId) || normalizedRegionId <= 0) {
    return { refreshed: false, insertedCount: 0 };
  }

  let insertedCount = 0;
  let batch = [];

  async function flushBatch() {
    if (batch.length === 0) return;
    const params = [];
    const valueSql = batch
      .map((row, index) => {
        const base = index * 14;
        params.push(
          normalizedRegionId,
          row.osm_type,
          row.osm_id,
          row.feature_kind,
          row.osm_type,
          row.osm_id,
          row.geometry_json,
          row.min_lon,
          row.min_lat,
          row.max_lon,
          row.max_lat,
          row.render_height_m,
          row.render_min_height_m,
          row.render_hide_base_when_parts
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14})`;
      })
      .join(', ');
    await client.query(
      `
      INSERT INTO osm.region_render_features (
        region_id,
        osm_type,
        osm_id,
        feature_kind,
        source_osm_type,
        source_osm_id,
        geom,
        min_lon,
        min_lat,
        max_lon,
        max_lat,
        render_height_m,
        render_min_height_m,
        render_hide_base_when_parts,
        updated_at
      )
      SELECT
        v.region_id,
        v.osm_type,
        v.osm_id,
        v.feature_kind,
        v.source_osm_type,
        v.source_osm_id,
        ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(v.geometry_json), 4326)),
        v.min_lon,
        v.min_lat,
        v.max_lon,
        v.max_lat,
        v.render_height_m,
        v.render_min_height_m,
        v.render_hide_base_when_parts,
        NOW()
      FROM (VALUES ${valueSql}) AS v (
        region_id,
        osm_type,
        osm_id,
        feature_kind,
        source_osm_type,
        source_osm_id,
        geometry_json,
        min_lon,
        min_lat,
        max_lon,
        max_lat,
        render_height_m,
        render_min_height_m,
        render_hide_base_when_parts
      )
    `,
      params
    );
    insertedCount += batch.length;
    batch = [];
  }

  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM osm.region_render_features WHERE region_id = $1', [normalizedRegionId]);
    for await (const row of readRenderedGeojsonFeatures(normalizedPath)) {
      const bounds = computeGeometryBounds(row.geometry);
      if (!bounds) continue;
      batch.push({
        ...row,
        min_lon: bounds.west,
        min_lat: bounds.south,
        max_lon: bounds.east,
        max_lat: bounds.north
      });
      if (batch.length >= POSTGRES_RENDER_CACHE_BATCH_SIZE) {
        await flushBatch();
      }
    }
    await flushBatch();
    await client.query('COMMIT');
    return {
      refreshed: insertedCount > 0,
      insertedCount
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw error;
  }
}

function createApplyProgressReporter({ onProgress, totalFeatureCount }) {
  const progressCallback = typeof onProgress === 'function' ? onProgress : null;
  const normalizedTotalFeatureCount = normalizeTotalFeatureCount(totalFeatureCount);
  let lastSignature = '';
  let lastRowsProgress = null;

  async function emit(progressEvent: LooseRecord = {}) {
    if (!progressCallback) return;

    const normalizedProgress = normalizeProgress(progressEvent.progress);
    const normalizedDetail = String(progressEvent.detail || '').trim() || null;
    const normalizedProcessedFeatureCount = Number.isInteger(Number(progressEvent.processedFeatureCount))
      ? Math.max(0, Number(progressEvent.processedFeatureCount))
      : null;
    const payload = {
      step: String(progressEvent.step || '').trim() || 'apply',
      progress: normalizedProgress,
      detail: normalizedDetail,
      processedFeatureCount: normalizedProcessedFeatureCount,
      totalFeatureCount: normalizedTotalFeatureCount
    };
    const signature = JSON.stringify(payload);
    if (signature === lastSignature) return;
    lastSignature = signature;
    await progressCallback(payload);
  }

  return {
    async reportRows(processedFeatureCount) {
      if (!normalizedTotalFeatureCount) return;
      const normalizedProcessedFeatureCount = Math.max(
        0,
        Math.min(normalizedTotalFeatureCount, Number(processedFeatureCount) || 0)
      );
      const progress = Math.min(
        APPLY_ROWS_PROGRESS_MAX,
        Math.floor((normalizedProcessedFeatureCount / normalizedTotalFeatureCount) * APPLY_ROWS_PROGRESS_MAX)
      );
      if (progress === lastRowsProgress && normalizedProcessedFeatureCount < normalizedTotalFeatureCount) return;
      lastRowsProgress = progress;
      await emit({
        step: 'rows',
        progress,
        detail: `writing imported rows ${normalizedProcessedFeatureCount}/${normalizedTotalFeatureCount}`,
        processedFeatureCount: normalizedProcessedFeatureCount
      });
    },
    async reportStep(step, progress, detail, extra = {}) {
      await emit({
        ...extra,
        step,
        progress,
        detail
      });
    }
  };
}

async function readImportRowsInBatches(ndjsonPath, readOptions, onBatch, batchSize = DEFAULT_IMPORT_APPLY_BATCH_SIZE) {
  const resolvedBatchSize = Math.max(1, Math.trunc(Number(batchSize) || DEFAULT_IMPORT_APPLY_BATCH_SIZE));
  let batch = [];
  let importedFeatureCount = 0;

  async function flush() {
    if (batch.length === 0) return;
    await onBatch(batch);
    importedFeatureCount += batch.length;
    batch = [];
  }

  for await (const row of readImportRows(ndjsonPath, readOptions)) {
    batch.push(row);
    if (batch.length >= resolvedBatchSize) {
      await flush();
    }
  }
  await flush();
  return importedFeatureCount;
}

async function createPostgresImportState(client) {
  await client.query(`
    CREATE TEMP TABLE region_import_stage_tmp (
      osm_type text NOT NULL,
      osm_id bigint NOT NULL,
      tags_json text,
      geometry_wkb_hex text NOT NULL,
      min_lon double precision NOT NULL,
      min_lat double precision NOT NULL,
      max_lon double precision NOT NULL,
      max_lat double precision NOT NULL
    ) ON COMMIT DROP
  `);
  await client.query(`
    CREATE TEMP TABLE region_orphan_candidates_tmp (
      osm_type text NOT NULL,
      osm_id bigint NOT NULL,
      PRIMARY KEY (osm_type, osm_id)
    ) ON COMMIT DROP
  `);
}

async function copyImportRowsIntoPostgresStage(
  client,
  { ndjsonPath, onProgress, progressInterval = DEFAULT_IMPORT_APPLY_BATCH_SIZE }
) {
  const normalizedProgressInterval = Math.max(
    1,
    Math.trunc(Number(progressInterval) || DEFAULT_IMPORT_APPLY_BATCH_SIZE)
  );
  let importedFeatureCount = 0;

  const source = Readable.from(
    (async function* () {
      for await (const row of readImportRows(ndjsonPath, { requireGeometryWkbHex: true })) {
        importedFeatureCount += 1;
        if (importedFeatureCount % normalizedProgressInterval === 0 && typeof onProgress === 'function') {
          await onProgress(importedFeatureCount);
        }
        yield buildPostgresCopyTextLine(row);
      }
    })()
  );

  const copyStream = client.query(
    copyFrom(`
    COPY region_import_stage_tmp (
      osm_type,
      osm_id,
      tags_json,
      geometry_wkb_hex,
      min_lon,
      min_lat,
      max_lon,
      max_lat
    )
    FROM STDIN WITH (FORMAT text)
  `)
  );

  await pipeline(source, copyStream);
  if (typeof onProgress === 'function') {
    await onProgress(importedFeatureCount);
  }
  return importedFeatureCount;
}

async function countPostgresInsertedContours(client) {
  const insertedCountResult = await client.query(`
    SELECT COUNT(*)::bigint AS total
    FROM region_import_stage_tmp src
    WHERE NOT EXISTS (
      SELECT 1
      FROM osm.building_contours bc
      WHERE bc.osm_type = src.osm_type
        AND bc.osm_id = src.osm_id
    )
  `);
  return Number(insertedCountResult.rows[0]?.total || 0);
}

async function createPostgresStageApplyState(client) {
  await client.query(`
    CREATE TEMP TABLE region_orphan_candidates_tmp (
      osm_type text NOT NULL,
      osm_id bigint NOT NULL,
      PRIMARY KEY (osm_type, osm_id)
    ) ON COMMIT DROP
  `);
}

async function countPostgresInsertedContoursFromStage(client, stageSchema, stageTable) {
  const stageRef = buildStageTableRef(stageSchema, stageTable);
  const result = await client.query(`
    SELECT COUNT(*)::bigint AS total
    FROM ${stageRef} src
    WHERE NOT EXISTS (
      SELECT 1
      FROM osm.building_contours bc
      WHERE bc.osm_type = ${buildStageOsmTypeSql('src.osm_type_code')}
        AND bc.osm_id = src.osm_id
    )
  `);
  return Number(result.rows[0]?.total || 0);
}

async function countPostgresStageRows(client, stageSchema, stageTable) {
  const stageRef = buildStageTableRef(stageSchema, stageTable);
  const result = await client.query(`
    SELECT COUNT(*)::bigint AS total
    FROM ${stageRef}
  `);
  return Number(result.rows[0]?.total || 0);
}

async function upsertPostgresContoursFromNamedStage(client, stageSchema, stageTable, runMarker) {
  const stageRef = buildStageTableRef(stageSchema, stageTable);
  await client.query(
    `
    INSERT INTO osm.building_contours (
      osm_type,
      osm_id,
      tags_json,
      min_lon,
      min_lat,
      max_lon,
      max_lat,
      geom,
      updated_at
    )
    SELECT
      ${buildStageOsmTypeSql('src.osm_type_code')} AS osm_type,
      src.osm_id,
      src.tags_json::text,
      src.min_lon,
      src.min_lat,
      src.max_lon,
      src.max_lat,
      ST_Multi(src.geom),
      $1::timestamptz
    FROM ${stageRef} src
    ORDER BY src.osm_type_code, src.osm_id
    ON CONFLICT (osm_type, osm_id) DO UPDATE SET
      tags_json = excluded.tags_json,
      min_lon = excluded.min_lon,
      min_lat = excluded.min_lat,
      max_lon = excluded.max_lon,
      max_lat = excluded.max_lat,
      geom = excluded.geom,
      updated_at = excluded.updated_at
    WHERE osm.building_contours.tags_json IS DISTINCT FROM excluded.tags_json
       OR osm.building_contours.geom IS DISTINCT FROM excluded.geom
       OR osm.building_contours.min_lon IS DISTINCT FROM excluded.min_lon
       OR osm.building_contours.min_lat IS DISTINCT FROM excluded.min_lat
       OR osm.building_contours.max_lon IS DISTINCT FROM excluded.max_lon
       OR osm.building_contours.max_lat IS DISTINCT FROM excluded.max_lat
  `,
    [runMarker]
  );
}

async function upsertPostgresMembershipsFromNamedStage(client, stageSchema, stageTable, regionId) {
  const stageRef = buildStageTableRef(stageSchema, stageTable);
  await client.query(
    `
    INSERT INTO public.data_region_memberships (
      region_id,
      osm_type,
      osm_id
    )
    SELECT
      $1::bigint,
      ${buildStageOsmTypeSql('src.osm_type_code')} AS osm_type,
      src.osm_id
    FROM ${stageRef} src
    ORDER BY src.osm_type_code, src.osm_id
    ON CONFLICT (region_id, osm_type, osm_id) DO NOTHING
  `,
    [regionId]
  );
}

async function hasPostgresRegionMemberships(client, regionId) {
  const result = await client.query(
    `
    SELECT 1
    FROM public.data_region_memberships
    WHERE region_id = $1
    LIMIT 1
  `,
    [regionId]
  );
  return (result.rowCount || 0) > 0;
}

async function deletePostgresStaleMembershipsFromNamedStage(
  client,
  stageSchema,
  stageTable,
  regionId,
  { hasExistingMemberships = null } = {}
) {
  const stageRef = buildStageTableRef(stageSchema, stageTable);
  const shouldCleanup =
    typeof hasExistingMemberships === 'boolean' ? hasExistingMemberships : await hasPostgresRegionMemberships(client, regionId);
  if (!shouldCleanup) {
    return false;
  }
  await client.query('TRUNCATE region_orphan_candidates_tmp');
  await client.query(
    `
    WITH stale AS (
      DELETE FROM public.data_region_memberships drm
      WHERE drm.region_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM ${stageRef} src
          WHERE ${buildStageOsmTypeSql('src.osm_type_code')} = drm.osm_type
            AND src.osm_id = drm.osm_id
        )
      RETURNING drm.osm_type, drm.osm_id
    )
    INSERT INTO region_orphan_candidates_tmp (
      osm_type,
      osm_id
    )
    SELECT
      stale.osm_type,
      stale.osm_id
    FROM stale
    ON CONFLICT (osm_type, osm_id) DO NOTHING
  `,
    [regionId]
  );
  return true;
}

async function upsertPostgresContoursFromStage(client, runMarker) {
  await client.query(
    `
    INSERT INTO osm.building_contours (
      osm_type,
      osm_id,
      tags_json,
      min_lon,
      min_lat,
      max_lon,
      max_lat,
      geom,
      updated_at
    )
    SELECT
      osm_type,
      osm_id,
      tags_json,
      min_lon,
      min_lat,
      max_lon,
      max_lat,
      ST_Multi(ST_GeomFromWKB(decode(geometry_wkb_hex, 'hex'), 4326)),
      $1::timestamptz
    FROM region_import_stage_tmp
    ON CONFLICT (osm_type, osm_id) DO UPDATE SET
      tags_json = excluded.tags_json,
      min_lon = excluded.min_lon,
      min_lat = excluded.min_lat,
      max_lon = excluded.max_lon,
      max_lat = excluded.max_lat,
      geom = excluded.geom,
      updated_at = excluded.updated_at
    WHERE osm.building_contours.tags_json IS DISTINCT FROM excluded.tags_json
       OR osm.building_contours.geom IS DISTINCT FROM excluded.geom
       OR osm.building_contours.min_lon IS DISTINCT FROM excluded.min_lon
       OR osm.building_contours.min_lat IS DISTINCT FROM excluded.min_lat
       OR osm.building_contours.max_lon IS DISTINCT FROM excluded.max_lon
       OR osm.building_contours.max_lat IS DISTINCT FROM excluded.max_lat
  `,
    [runMarker]
  );
}

async function upsertPostgresMembershipsFromStage(client, regionId) {
  await client.query(
    `
    INSERT INTO public.data_region_memberships (
      region_id,
      osm_type,
      osm_id
    )
    SELECT
      $1::bigint,
      osm_type,
      osm_id
    FROM region_import_stage_tmp
    ORDER BY osm_type, osm_id
    ON CONFLICT (region_id, osm_type, osm_id) DO NOTHING
  `,
    [regionId]
  );
}

async function deletePostgresStaleMemberships(client, regionId, { hasExistingMemberships = null } = {}) {
  const shouldCleanup =
    typeof hasExistingMemberships === 'boolean' ? hasExistingMemberships : await hasPostgresRegionMemberships(client, regionId);
  if (!shouldCleanup) {
    return false;
  }
  await client.query('TRUNCATE region_orphan_candidates_tmp');
  await client.query(
    `
    WITH stale AS (
      DELETE FROM public.data_region_memberships drm
      WHERE drm.region_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM region_import_stage_tmp src
          WHERE src.osm_type = drm.osm_type
            AND src.osm_id = drm.osm_id
        )
      RETURNING drm.osm_type, drm.osm_id
    )
    INSERT INTO region_orphan_candidates_tmp (
      osm_type,
      osm_id
    )
    SELECT
      stale.osm_type,
      stale.osm_id
    FROM stale
    ON CONFLICT (osm_type, osm_id) DO NOTHING
  `,
    [regionId]
  );
  return true;
}

async function lockPostgresContourSummary(client) {
  const existing = await client.query(`
    SELECT total, last_updated
    FROM osm.building_contours_summary
    WHERE singleton_id = 1
    FOR UPDATE
  `);
  if ((existing.rowCount || 0) > 0) {
    return {
      total: Number(existing.rows[0]?.total || 0),
      lastUpdated: existing.rows[0]?.last_updated || null
    };
  }

  const fallback = await client.query(`
    SELECT COUNT(*)::bigint AS total, MAX(updated_at) AS last_updated
    FROM osm.building_contours
  `);
  const row = fallback.rows[0] || {};
  await client.query(
    `
    INSERT INTO osm.building_contours_summary (singleton_id, total, last_updated, refreshed_at)
    VALUES (1, $1::bigint, $2::timestamptz, NOW())
    ON CONFLICT (singleton_id) DO NOTHING
  `,
    [Number(row.total || 0), row.last_updated || null]
  );

  return {
    total: Number(row.total || 0),
    lastUpdated: row.last_updated || null
  };
}

function normalizeSourceSnapshotForInsert(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const sha256 = String(snapshot.sha256 || '').trim();
  if (!sha256) return null;
  const sizeBytes = Number(snapshot.sizeBytes);
  return {
    extractSource: String(snapshot.extractSource || '').trim() || null,
    extractId: String(snapshot.extractId || '').trim() || null,
    sha256,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? Math.trunc(sizeBytes) : 0,
    sourceMtime: String(snapshot.sourceMtime || '').trim() || null,
    localPath: String(snapshot.localPath || '').trim() || null
  };
}

async function recordPostgresRegionSourceSnapshot(
  client,
  { region, sourceSnapshot, importedFeatureCount, pmtilesBytes }
) {
  const normalized = normalizeSourceSnapshotForInsert(sourceSnapshot);
  if (!normalized) return null;
  const regionId = Number(region?.id || 0);
  if (!Number.isInteger(regionId) || regionId <= 0) return null;

  // Mark the previously-active row as superseded while retaining full source
  // history for audit/debug and upstream freshness comparisons.
  await client.query(
    `
    UPDATE public.data_region_source_snapshots
    SET is_active = 0,
        superseded_at = COALESCE(superseded_at, NOW())
    WHERE region_id = $1 AND is_active = 1
  `,
    [regionId]
  );

  const inserted = await client.query(
    `
    INSERT INTO public.data_region_source_snapshots (
      region_id,
      extract_source,
      extract_id,
      sha256,
      size_bytes,
      source_mtime,
      local_path,
      imported_feature_count,
      pmtiles_bytes,
      is_active
    )
    VALUES ($1::bigint, $2, $3, $4, $5::bigint, $6::timestamptz, $7, $8::bigint, $9::bigint, 1)
    RETURNING id
  `,
    [
      regionId,
      normalized.extractSource,
      normalized.extractId,
      normalized.sha256,
      normalized.sizeBytes,
      normalized.sourceMtime,
      normalized.localPath,
      Number.isFinite(Number(importedFeatureCount)) ? Math.trunc(Number(importedFeatureCount)) : null,
      Number.isFinite(Number(pmtilesBytes)) ? Math.trunc(Number(pmtilesBytes)) : null
    ]
  );
  return Number(inserted.rows[0]?.id || 0) || null;
}

async function writePostgresContourSummary(client, total, lastUpdated) {
  await client.query(
    `
    INSERT INTO osm.building_contours_summary (singleton_id, total, last_updated, refreshed_at)
    VALUES (1, $1::bigint, $2::timestamptz, NOW())
    ON CONFLICT (singleton_id) DO UPDATE SET
      total = EXCLUDED.total,
      last_updated = EXCLUDED.last_updated,
      refreshed_at = EXCLUDED.refreshed_at
  `,
    [Number(total || 0), lastUpdated || null]
  );
}

async function applyRegionImportToPostgres({
  region,
  ndjsonPath,
  builtPmtilesPath,
  databaseUrl,
  dataDir,
  renderGeojsonPath,
  totalFeatureCount,
  sourceSnapshot = null,
  onProgress
}) {
  const client = new Client({ connectionString: databaseUrl });
  const runMarker = new Date().toISOString();
  const normalizedBuiltPmtilesPath = String(builtPmtilesPath || '').trim();
  const finalPmtilesPath = normalizedBuiltPmtilesPath ? resolveRegionPmtilesPath(dataDir, region) : null;
  let swap = null;
  const progressReporter = createApplyProgressReporter({
    onProgress,
    totalFeatureCount
  });
  const importApplyBatchSize = resolveImportApplyBatchSize();

  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL synchronous_commit = off');
      await createPostgresImportState(client);
      const summaryBefore = await lockPostgresContourSummary(client);
      await progressReporter.reportRows(0);
      const importedFeatureCount = await copyImportRowsIntoPostgresStage(client, {
        ndjsonPath,
        onProgress: async (processedFeatureCount) => {
          await progressReporter.reportRows(processedFeatureCount);
        },
        progressInterval: importApplyBatchSize
      });
      await progressReporter.reportStep('count_new', APPLY_COUNT_NEW_PROGRESS, 'counting new contours', {
        processedFeatureCount: importedFeatureCount
      });
      const insertedContourCount = await countPostgresInsertedContours(client);

      await progressReporter.reportStep('upsert', APPLY_UPSERT_PROGRESS, `upserting ${importedFeatureCount} contours`, {
        processedFeatureCount: importedFeatureCount
      });
      await upsertPostgresContoursFromStage(client, runMarker);

      await progressReporter.reportStep('memberships', APPLY_MEMBERSHIPS_PROGRESS, 'upserting region memberships', {
        processedFeatureCount: importedFeatureCount
      });
      const hasExistingMemberships = await hasPostgresRegionMemberships(client, region.id);
      await upsertPostgresMembershipsFromStage(client, region.id);

      if (finalPmtilesPath) {
        swap = buildPmtilesSwap(finalPmtilesPath, normalizedBuiltPmtilesPath);
      }

      await progressReporter.reportStep(
        'stale_memberships',
        APPLY_STALE_MEMBERSHIPS_PROGRESS,
        hasExistingMemberships
          ? 'removing stale region memberships'
          : 'skipping stale region memberships on first sync',
        { processedFeatureCount: importedFeatureCount }
      );
      const staleMembershipCleanupRan = await deletePostgresStaleMemberships(client, region.id, {
        hasExistingMemberships
      });
      let orphanDeletedCount = 0;
      if (staleMembershipCleanupRan) {
        await progressReporter.reportStep('orphan_cleanup', APPLY_ORPHAN_CLEANUP_PROGRESS, 'removing orphan contours', {
          processedFeatureCount: importedFeatureCount
        });
        const orphanDeleted = await client.query(`
          DELETE FROM osm.building_contours bc
          WHERE EXISTS (
            SELECT 1
            FROM region_orphan_candidates_tmp candidates
            WHERE candidates.osm_type = bc.osm_type
              AND candidates.osm_id = bc.osm_id
          )
            AND NOT EXISTS (
            SELECT 1
            FROM public.data_region_memberships drm
            WHERE drm.osm_type = bc.osm_type
              AND drm.osm_id = bc.osm_id
          )
        `);
        orphanDeletedCount = Number(orphanDeleted.rowCount || 0);
      }

      await progressReporter.reportStep(
        'summary_refresh',
        APPLY_SUMMARY_REFRESH_PROGRESS,
        'refreshing contour summary',
        { processedFeatureCount: importedFeatureCount }
      );
      const nextSummaryTotal = computePostgresContourSummaryTotal(
        summaryBefore.total,
        insertedContourCount,
        orphanDeletedCount
      );
      await writePostgresContourSummary(client, nextSummaryTotal, nextSummaryTotal > 0 ? runMarker : null);

      let sourceSnapshotId = null;
      try {
        sourceSnapshotId = await recordPostgresRegionSourceSnapshot(client, {
          region,
          sourceSnapshot,
          importedFeatureCount,
          pmtilesBytes: normalizedBuiltPmtilesPath && fs.existsSync(normalizedBuiltPmtilesPath)
            ? Number(fs.statSync(normalizedBuiltPmtilesPath).size || 0)
            : null
        });
      } catch (error) {
        console.warn(`[region-sync] source snapshot record skipped: ${String(error?.message || error)}`);
      }

      await client.query('COMMIT');
      if (swap) {
        swap.commit();
      }

      let renderCacheRows = 0;
      if (shouldRefreshPostgresRenderCache() && renderGeojsonPath) {
        try {
          const refreshResult = await refreshPostgresRegionRenderCache(client, {
            region,
            renderGeojsonPath
          });
          renderCacheRows = Number(refreshResult?.insertedCount || 0);
        } catch (error) {
          console.warn(`[region-sync] Postgres render cache refresh skipped: ${String(error?.message || error)}`);
        }
      }

      const activeFeatureCount = Number(
        (
          await client.query(
            `
        SELECT COUNT(*)::bigint AS total
        FROM public.data_region_memberships
        WHERE region_id = $1
      `,
            [region.id]
          )
        ).rows[0]?.total || 0
      );
      await progressReporter.reportStep('complete', APPLY_COMPLETE_PROGRESS, 'database import applied', {
        processedFeatureCount: importedFeatureCount
      });

      return {
        importedFeatureCount,
        activeFeatureCount,
        orphanDeletedCount,
        renderCacheRows,
        sourceSnapshotId,
        pmtilesBytes: finalPmtilesPath ? Number(fs.statSync(finalPmtilesPath).size || 0) : null,
        pmtilesPath: finalPmtilesPath
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      if (swap) {
        swap.rollback();
      }
      throw error;
    }
  } finally {
    await client.end();
  }
}

async function applyRegionImportFromPostgresStage({
  region,
  databaseUrl,
  stageSchema,
  stageTable,
  totalFeatureCount,
  sourceSnapshot = null,
  onProgress
}) {
  const client = new Client({ connectionString: databaseUrl });
  const runMarker = new Date().toISOString();
  const progressReporter = createApplyProgressReporter({
    onProgress,
    totalFeatureCount
  });

  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL synchronous_commit = off');
      await createPostgresStageApplyState(client);
      await preparePostgresStageApplyOrdering(client, stageSchema, stageTable);
      const summaryBefore = await lockPostgresContourSummary(client);
      const importedFeatureCount = Number(totalFeatureCount || 0) || (await countPostgresStageRows(client, stageSchema, stageTable));
      await progressReporter.reportRows(importedFeatureCount);
      await progressReporter.reportStep('count_new', APPLY_COUNT_NEW_PROGRESS, 'counting new contours', {
        processedFeatureCount: importedFeatureCount
      });
      const insertedContourCount = await countPostgresInsertedContoursFromStage(client, stageSchema, stageTable);

      await progressReporter.reportStep('upsert', APPLY_UPSERT_PROGRESS, `upserting ${importedFeatureCount} contours`, {
        processedFeatureCount: importedFeatureCount
      });
      await upsertPostgresContoursFromNamedStage(client, stageSchema, stageTable, runMarker);

      await progressReporter.reportStep('memberships', APPLY_MEMBERSHIPS_PROGRESS, 'upserting region memberships', {
        processedFeatureCount: importedFeatureCount
      });
      const hasExistingMemberships = await hasPostgresRegionMemberships(client, region.id);
      await upsertPostgresMembershipsFromNamedStage(client, stageSchema, stageTable, region.id);

      await progressReporter.reportStep(
        'stale_memberships',
        APPLY_STALE_MEMBERSHIPS_PROGRESS,
        hasExistingMemberships
          ? 'removing stale region memberships'
          : 'skipping stale region memberships on first sync',
        { processedFeatureCount: importedFeatureCount }
      );
      const staleMembershipCleanupRan = await deletePostgresStaleMembershipsFromNamedStage(
        client,
        stageSchema,
        stageTable,
        region.id,
        { hasExistingMemberships }
      );
      let orphanDeletedCount = 0;
      if (staleMembershipCleanupRan) {
        await progressReporter.reportStep('orphan_cleanup', APPLY_ORPHAN_CLEANUP_PROGRESS, 'removing orphan contours', {
          processedFeatureCount: importedFeatureCount
        });
        const orphanDeleted = await client.query(`
          DELETE FROM osm.building_contours bc
          WHERE EXISTS (
            SELECT 1
            FROM region_orphan_candidates_tmp candidates
            WHERE candidates.osm_type = bc.osm_type
              AND candidates.osm_id = bc.osm_id
          )
            AND NOT EXISTS (
            SELECT 1
            FROM public.data_region_memberships drm
            WHERE drm.osm_type = bc.osm_type
              AND drm.osm_id = bc.osm_id
          )
        `);
        orphanDeletedCount = Number(orphanDeleted.rowCount || 0);
      }

      await progressReporter.reportStep(
        'summary_refresh',
        APPLY_SUMMARY_REFRESH_PROGRESS,
        'refreshing contour summary',
        { processedFeatureCount: importedFeatureCount }
      );
      const nextSummaryTotal = computePostgresContourSummaryTotal(
        summaryBefore.total,
        insertedContourCount,
        orphanDeletedCount
      );
      await writePostgresContourSummary(client, nextSummaryTotal, nextSummaryTotal > 0 ? runMarker : null);

      let sourceSnapshotId = null;
      try {
        sourceSnapshotId = await recordPostgresRegionSourceSnapshot(client, {
          region,
          sourceSnapshot,
          importedFeatureCount,
          pmtilesBytes: null
        });
      } catch (error) {
        console.warn(`[region-sync] source snapshot record skipped: ${String(error?.message || error)}`);
      }

      await client.query('COMMIT');

      const activeFeatureCount = Number(
        (
          await client.query(
            `
              SELECT COUNT(*)::bigint AS total
              FROM public.data_region_memberships
              WHERE region_id = $1
            `,
            [region.id]
          )
        ).rows[0]?.total || 0
      );
      await progressReporter.reportStep('complete', APPLY_COMPLETE_PROGRESS, 'database import applied', {
        processedFeatureCount: importedFeatureCount
      });

      return {
        importedFeatureCount,
        activeFeatureCount,
        orphanDeletedCount,
        renderCacheRows: 0,
        sourceSnapshotId,
        pmtilesBytes: null,
        pmtilesPath: null
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      throw error;
    }
  } finally {
    await client.end();
  }
}

function publishPmtilesArchive({ dataDir, region, builtPmtilesPath }) {
  const finalArchivePath = resolveRegionPmtilesPath(dataDir, region);
  const stagedSwap = buildPmtilesSwap(finalArchivePath, builtPmtilesPath);
  stagedSwap.commit();
  return finalArchivePath;
}

module.exports = {
  applyRegionImportFromPostgresStage,
  buildPostgresCopyTextLine,
  computePostgresContourSummaryTotal,
  escapePostgresCopyTextValue,
  deletePostgresStaleMemberships,
  deletePostgresStaleMembershipsFromNamedStage,
  hasPostgresRegionMemberships,
  normalizeSourceSnapshotForInsert,
  publishPmtilesArchive,
  resolveImportApplyBatchSize
};
