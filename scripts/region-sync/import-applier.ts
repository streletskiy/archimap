const fs = require('fs');
const { Client } = require('pg');
const { resolveRegionPmtilesPath } = require('../../src/lib/server/services/data-settings.service');
const { buildPmtilesSwap, readImportRows } = require('./common');
const { openSqliteRegionDb } = require('./region-db');

const IMPORT_APPLY_BATCH_SIZE = 1000;
const APPLY_ROWS_PROGRESS_MAX = 90;
const APPLY_STALE_MEMBERSHIPS_PROGRESS = 94;
const APPLY_ORPHAN_CLEANUP_PROGRESS = 98;
const APPLY_SUMMARY_REFRESH_PROGRESS = 99;
const APPLY_COMPLETE_PROGRESS = 100;

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

function createApplyProgressReporter({ onProgress, totalFeatureCount }) {
  const progressCallback = typeof onProgress === 'function' ? onProgress : null;
  const normalizedTotalFeatureCount = normalizeTotalFeatureCount(totalFeatureCount);
  let lastSignature = '';
  let lastRowsProgress = null;

  async function emit(progressEvent = {}) {
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

async function readImportRowsInBatches(ndjsonPath, readOptions, onBatch) {
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
    if (batch.length >= IMPORT_APPLY_BATCH_SIZE) {
      await flush();
    }
  }
  await flush();
  return importedFeatureCount;
}

async function insertImportRowsIntoPostgresBatch(client, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const values = [];
  const params = [];
  let cursor = 1;
  for (const row of rows) {
    values.push(`($${cursor++}, $${cursor++}, $${cursor++}, $${cursor++}, $${cursor++}, $${cursor++}, $${cursor++}, $${cursor++})`);
    params.push(
      row.osm_type,
      row.osm_id,
      row.tags_json,
      row.geometry_wkb_hex,
      row.min_lon,
      row.min_lat,
      row.max_lon,
      row.max_lat
    );
  }
  await client.query(`
    INSERT INTO region_import_batch_tmp (
      osm_type,
      osm_id,
      tags_json,
      geometry_wkb_hex,
      min_lon,
      min_lat,
      max_lon,
      max_lat
    )
    VALUES ${values.join(', ')}
  `, params);
}

async function createPostgresImportBatchState(client) {
  await client.query(`
    CREATE TEMP TABLE region_import_batch_tmp (
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
    CREATE TEMP TABLE region_import_seen_tmp (
      osm_type text NOT NULL,
      osm_id bigint NOT NULL,
      PRIMARY KEY (osm_type, osm_id)
    ) ON COMMIT DROP
  `);

  return {
    async applyBatch(rows, regionId, runMarker) {
      if (!Array.isArray(rows) || rows.length === 0) return;
      await client.query('TRUNCATE region_import_batch_tmp');
      await insertImportRowsIntoPostgresBatch(client, rows);
      await client.query(`
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
        FROM region_import_batch_tmp
        ON CONFLICT (osm_type, osm_id) DO UPDATE SET
          tags_json = excluded.tags_json,
          min_lon = excluded.min_lon,
          min_lat = excluded.min_lat,
          max_lon = excluded.max_lon,
          max_lat = excluded.max_lat,
          geom = excluded.geom,
          updated_at = excluded.updated_at
      `, [runMarker]);
      await client.query(`
        INSERT INTO region_import_seen_tmp (
          osm_type,
          osm_id
        )
        SELECT
          osm_type,
          osm_id
        FROM region_import_batch_tmp
        ON CONFLICT (osm_type, osm_id) DO NOTHING
      `);
      await client.query(`
        INSERT INTO public.data_region_memberships (
          region_id,
          osm_type,
          osm_id
        )
        SELECT
          $1::bigint,
          osm_type,
          osm_id
        FROM region_import_batch_tmp
        ON CONFLICT (region_id, osm_type, osm_id) DO NOTHING
      `, [regionId]);
      await client.query('TRUNCATE region_import_batch_tmp');
    },
    async deleteStaleMemberships(regionId) {
      await client.query(`
        DELETE FROM public.data_region_memberships drm
        WHERE drm.region_id = $1
          AND NOT EXISTS (
            SELECT 1
            FROM region_import_seen_tmp src
            WHERE src.osm_type = drm.osm_type
              AND src.osm_id = drm.osm_id
          )
      `, [regionId]);
    }
  };
}

function createSqliteImportBatchState(db) {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS region_import_batch_tmp (
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      tags_json TEXT,
      geometry_json TEXT NOT NULL,
      min_lon REAL NOT NULL,
      min_lat REAL NOT NULL,
      max_lon REAL NOT NULL,
      max_lat REAL NOT NULL
    );
    CREATE TEMP TABLE IF NOT EXISTS region_import_seen_tmp (
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      PRIMARY KEY (osm_type, osm_id)
    ) WITHOUT ROWID;
    DELETE FROM temp.region_import_batch_tmp;
    DELETE FROM temp.region_import_seen_tmp;
  `);

  const clearBatch = db.prepare('DELETE FROM temp.region_import_batch_tmp');
  const insertBatchRow = db.prepare(`
    INSERT INTO temp.region_import_batch_tmp (
      osm_type,
      osm_id,
      tags_json,
      geometry_json,
      min_lon,
      min_lat,
      max_lon,
      max_lat
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertContours = db.prepare(`
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
    SELECT
      osm_type,
      osm_id,
      tags_json,
      geometry_json,
      min_lon,
      min_lat,
      max_lon,
      max_lat,
      ?
    FROM temp.region_import_batch_tmp
    WHERE 1
    ON CONFLICT(osm_type, osm_id) DO UPDATE SET
      tags_json = excluded.tags_json,
      geometry_json = excluded.geometry_json,
      min_lon = excluded.min_lon,
      min_lat = excluded.min_lat,
      max_lon = excluded.max_lon,
      max_lat = excluded.max_lat,
      updated_at = excluded.updated_at
  `);
  const insertSeen = db.prepare(`
    INSERT OR IGNORE INTO temp.region_import_seen_tmp (
      osm_type,
      osm_id
    )
    SELECT
      osm_type,
      osm_id
    FROM temp.region_import_batch_tmp
  `);
  const upsertMemberships = db.prepare(`
    INSERT INTO data_region_memberships (
      region_id,
      osm_type,
      osm_id,
      created_at,
      updated_at
    )
    SELECT
      ?,
      osm_type,
      osm_id,
      ?,
      ?
    FROM temp.region_import_batch_tmp
    WHERE 1
    ON CONFLICT(region_id, osm_type, osm_id) DO UPDATE SET
      updated_at = excluded.updated_at
  `);
  const deleteStaleMemberships = db.prepare(`
    DELETE FROM data_region_memberships
    WHERE region_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM temp.region_import_seen_tmp src
        WHERE src.osm_type = data_region_memberships.osm_type
          AND src.osm_id = data_region_memberships.osm_id
      )
  `);

  return {
    applyBatch(rows, regionId, runMarker) {
      if (!Array.isArray(rows) || rows.length === 0) return;
      clearBatch.run();
      for (const row of rows) {
        insertBatchRow.run(
          row.osm_type,
          row.osm_id,
          row.tags_json,
          row.geometry_json,
          row.min_lon,
          row.min_lat,
          row.max_lon,
          row.max_lat
        );
      }
      upsertContours.run(runMarker);
      insertSeen.run();
      upsertMemberships.run(regionId, runMarker, runMarker);
      clearBatch.run();
    },
    deleteStaleMemberships(regionId) {
      deleteStaleMemberships.run(regionId);
    }
  };
}

async function applyRegionImportToSqlite({
  region,
  ndjsonPath,
  builtPmtilesPath,
  archimapDbPath,
  osmDbPath,
  dataDir,
  totalFeatureCount,
  onProgress
}) {
  const db = openSqliteRegionDb(archimapDbPath, osmDbPath);
  const runMarker = new Date().toISOString();
  const normalizedBuiltPmtilesPath = String(builtPmtilesPath || '').trim();
  const finalPmtilesPath = normalizedBuiltPmtilesPath
    ? resolveRegionPmtilesPath(dataDir, region)
    : null;
  let swap = null;
  const progressReporter = createApplyProgressReporter({
    onProgress,
    totalFeatureCount
  });

  try {
    const batchState = createSqliteImportBatchState(db);
    db.exec('BEGIN');
    try {
      let processedFeatureCount = 0;
      await progressReporter.reportRows(0);
      const importedFeatureCount = await readImportRowsInBatches(
        ndjsonPath,
        { requireGeometryJson: true },
        async (rows) => {
          batchState.applyBatch(rows, region.id, runMarker);
          processedFeatureCount += rows.length;
          await progressReporter.reportRows(processedFeatureCount);
        }
      );

      if (finalPmtilesPath) {
        swap = buildPmtilesSwap(finalPmtilesPath, normalizedBuiltPmtilesPath);
      }

      await progressReporter.reportStep(
        'stale_memberships',
        APPLY_STALE_MEMBERSHIPS_PROGRESS,
        'removing stale region memberships',
        { processedFeatureCount: importedFeatureCount }
      );
      batchState.deleteStaleMemberships(region.id);

      await progressReporter.reportStep(
        'orphan_cleanup',
        APPLY_ORPHAN_CLEANUP_PROGRESS,
        'removing orphan contours',
        { processedFeatureCount: importedFeatureCount }
      );
      const orphanDeletedCount = Number(db.prepare(`
        DELETE FROM osm.building_contours
        WHERE NOT EXISTS (
          SELECT 1
          FROM data_region_memberships drm
          WHERE drm.osm_type = osm.building_contours.osm_type
            AND drm.osm_id = osm.building_contours.osm_id
        )
      `).run()?.changes || 0);

      db.exec('COMMIT');
      if (swap) {
        swap.commit();
      }

      const activeFeatureCount = Number(db.prepare(`
        SELECT COUNT(*) AS total
        FROM data_region_memberships
        WHERE region_id = ?
      `).get(region.id)?.total || 0);
      await progressReporter.reportStep(
        'complete',
        APPLY_COMPLETE_PROGRESS,
        'database import applied',
        {
          processedFeatureCount: importedFeatureCount
        }
      );

      return {
        importedFeatureCount,
        activeFeatureCount,
        orphanDeletedCount,
        pmtilesBytes: finalPmtilesPath ? Number(fs.statSync(finalPmtilesPath).size || 0) : null,
        pmtilesPath: finalPmtilesPath
      };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      if (swap) {
        swap.rollback();
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

async function applyRegionImportToPostgres({
  region,
  ndjsonPath,
  builtPmtilesPath,
  databaseUrl,
  dataDir,
  totalFeatureCount,
  onProgress
}) {
  const client = new Client({ connectionString: databaseUrl });
  const runMarker = new Date().toISOString();
  const normalizedBuiltPmtilesPath = String(builtPmtilesPath || '').trim();
  const finalPmtilesPath = normalizedBuiltPmtilesPath
    ? resolveRegionPmtilesPath(dataDir, region)
    : null;
  let swap = null;
  const progressReporter = createApplyProgressReporter({
    onProgress,
    totalFeatureCount
  });

  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      const batchState = await createPostgresImportBatchState(client);
      let processedFeatureCount = 0;
      await progressReporter.reportRows(0);
      const importedFeatureCount = await readImportRowsInBatches(
        ndjsonPath,
        { requireGeometryWkbHex: true },
        async (rows) => {
          await batchState.applyBatch(rows, region.id, runMarker);
          processedFeatureCount += rows.length;
          await progressReporter.reportRows(processedFeatureCount);
        }
      );

      if (finalPmtilesPath) {
        swap = buildPmtilesSwap(finalPmtilesPath, normalizedBuiltPmtilesPath);
      }

      await progressReporter.reportStep(
        'stale_memberships',
        APPLY_STALE_MEMBERSHIPS_PROGRESS,
        'removing stale region memberships',
        { processedFeatureCount: importedFeatureCount }
      );
      await batchState.deleteStaleMemberships(region.id);

      await progressReporter.reportStep(
        'orphan_cleanup',
        APPLY_ORPHAN_CLEANUP_PROGRESS,
        'removing orphan contours',
        { processedFeatureCount: importedFeatureCount }
      );
      const orphanDeleted = await client.query(`
        DELETE FROM osm.building_contours bc
        WHERE NOT EXISTS (
          SELECT 1
          FROM public.data_region_memberships drm
          WHERE drm.osm_type = bc.osm_type
            AND drm.osm_id = bc.osm_id
        )
      `);

      await progressReporter.reportStep(
        'summary_refresh',
        APPLY_SUMMARY_REFRESH_PROGRESS,
        'refreshing contour summary',
        { processedFeatureCount: importedFeatureCount }
      );
      await client.query(`
        INSERT INTO osm.building_contours_summary (singleton_id, total, last_updated, refreshed_at)
        SELECT 1, COUNT(*)::bigint, MAX(updated_at), NOW()
        FROM osm.building_contours
        ON CONFLICT (singleton_id) DO UPDATE SET
          total = EXCLUDED.total,
          last_updated = EXCLUDED.last_updated,
          refreshed_at = EXCLUDED.refreshed_at
      `);

      await client.query('COMMIT');
      if (swap) {
        swap.commit();
      }

      const activeFeatureCount = Number((await client.query(`
        SELECT COUNT(*)::bigint AS total
        FROM public.data_region_memberships
        WHERE region_id = $1
      `, [region.id])).rows[0]?.total || 0);
      await progressReporter.reportStep(
        'complete',
        APPLY_COMPLETE_PROGRESS,
        'database import applied',
        {
          processedFeatureCount: importedFeatureCount
        }
      );

      return {
        importedFeatureCount,
        activeFeatureCount,
        orphanDeletedCount: Number(orphanDeleted.rowCount || 0),
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

async function applyRegionImport(options) {
  if (options.dbProvider === 'postgres') {
    return applyRegionImportToPostgres(options);
  }
  return applyRegionImportToSqlite(options);
}

function publishPmtilesArchive({ dataDir, region, builtPmtilesPath }) {
  const finalArchivePath = resolveRegionPmtilesPath(dataDir, region);
  const stagedSwap = buildPmtilesSwap(finalArchivePath, builtPmtilesPath);
  stagedSwap.commit();
  return finalArchivePath;
}

module.exports = {
  applyRegionImport,
  publishPmtilesArchive
};
