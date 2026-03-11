const fs = require('fs');
const { Client } = require('pg');
const { resolveRegionPmtilesPath } = require('../../src/lib/server/services/data-settings.service');
const { buildPmtilesSwap, readImportRows } = require('./common');
const { openSqliteRegionDb } = require('./region-db');

async function insertImportRowsIntoPostgres(client, ndjsonPath) {
  const rows = [];
  const batchSize = 1000;
  let importedFeatureCount = 0;

  async function flush() {
    if (rows.length === 0) return;
    const values = [];
    const params = [];
    let cursor = 1;
    for (const row of rows) {
      values.push(`($${cursor++}, $${cursor++}, $${cursor++}, $${cursor++}, $${cursor++}, $${cursor++}, $${cursor++}, $${cursor++})`);
      params.push(
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
    await client.query(`
      INSERT INTO region_import_tmp (
        osm_type,
        osm_id,
        tags_json,
        geometry_json,
        min_lon,
        min_lat,
        max_lon,
        max_lat
      )
      VALUES ${values.join(', ')}
    `, params);
    importedFeatureCount += rows.length;
    rows.length = 0;
  }

  for await (const row of readImportRows(ndjsonPath)) {
    rows.push(row);
    if (rows.length >= batchSize) {
      await flush();
    }
  }
  await flush();
  return importedFeatureCount;
}

function insertImportRowsIntoSqlite(db, ndjsonPath) {
  const insertRow = db.prepare(`
    INSERT INTO temp.region_import_tmp (
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
  const insertBatch = db.transaction((rows) => {
    for (const row of rows) {
      insertRow.run(
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
  });

  return (async () => {
    let importedFeatureCount = 0;
    let batch = [];
    for await (const row of readImportRows(ndjsonPath)) {
      batch.push(row);
      if (batch.length >= 1000) {
        insertBatch(batch);
        importedFeatureCount += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      insertBatch(batch);
      importedFeatureCount += batch.length;
    }
    return importedFeatureCount;
  })();
}

async function applyRegionImportToSqlite({ region, ndjsonPath, builtPmtilesPath, archimapDbPath, osmDbPath, dataDir }) {
  const db = openSqliteRegionDb(archimapDbPath, osmDbPath);
  const runMarker = new Date().toISOString();
  const finalPmtilesPath = resolveRegionPmtilesPath(dataDir, region);
  let swap = null;

  try {
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS region_import_tmp (
        osm_type TEXT NOT NULL,
        osm_id INTEGER NOT NULL,
        tags_json TEXT,
        geometry_json TEXT NOT NULL,
        min_lon REAL NOT NULL,
        min_lat REAL NOT NULL,
        max_lon REAL NOT NULL,
        max_lat REAL NOT NULL
      );
      DELETE FROM temp.region_import_tmp;
    `);

    const importedFeatureCount = await insertImportRowsIntoSqlite(db, ndjsonPath);

    db.exec('BEGIN');
    try {
      swap = buildPmtilesSwap(finalPmtilesPath, builtPmtilesPath);

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
        FROM temp.region_import_tmp
        ON CONFLICT(osm_type, osm_id) DO UPDATE SET
          tags_json = excluded.tags_json,
          geometry_json = excluded.geometry_json,
          min_lon = excluded.min_lon,
          min_lat = excluded.min_lat,
          max_lon = excluded.max_lon,
          max_lat = excluded.max_lat,
          updated_at = excluded.updated_at
      `).run(runMarker);

      db.prepare(`
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
        FROM temp.region_import_tmp
        ON CONFLICT(region_id, osm_type, osm_id) DO UPDATE SET
          updated_at = excluded.updated_at
      `).run(region.id, runMarker, runMarker);

      db.prepare(`
        DELETE FROM data_region_memberships
        WHERE region_id = ?
          AND NOT EXISTS (
            SELECT 1
            FROM temp.region_import_tmp src
            WHERE src.osm_type = data_region_memberships.osm_type
              AND src.osm_id = data_region_memberships.osm_id
          )
      `).run(region.id);

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
      swap.commit();

      const activeFeatureCount = Number(db.prepare(`
        SELECT COUNT(*) AS total
        FROM data_region_memberships
        WHERE region_id = ?
      `).get(region.id)?.total || 0);

      return {
        importedFeatureCount,
        activeFeatureCount,
        orphanDeletedCount,
        pmtilesBytes: Number(fs.statSync(finalPmtilesPath).size || 0),
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

async function applyRegionImportToPostgres({ region, ndjsonPath, builtPmtilesPath, databaseUrl, dataDir }) {
  const client = new Client({ connectionString: databaseUrl });
  const runMarker = new Date().toISOString();
  const finalPmtilesPath = resolveRegionPmtilesPath(dataDir, region);
  let swap = null;

  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE TEMP TABLE region_import_tmp (
          osm_type text NOT NULL,
          osm_id bigint NOT NULL,
          tags_json text,
          geometry_json text NOT NULL,
          min_lon double precision NOT NULL,
          min_lat double precision NOT NULL,
          max_lon double precision NOT NULL,
          max_lat double precision NOT NULL
        ) ON COMMIT DROP
      `);
      const importedFeatureCount = await insertImportRowsIntoPostgres(client, ndjsonPath);

      swap = buildPmtilesSwap(finalPmtilesPath, builtPmtilesPath);

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
          ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(geometry_json), 4326)),
          $1::timestamptz
        FROM region_import_tmp
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
        INSERT INTO public.data_region_memberships (
          region_id,
          osm_type,
          osm_id
        )
        SELECT
          $1::bigint,
          osm_type,
          osm_id
        FROM region_import_tmp
        ON CONFLICT (region_id, osm_type, osm_id) DO NOTHING
      `, [region.id]);

      await client.query(`
        DELETE FROM public.data_region_memberships drm
        WHERE drm.region_id = $1
          AND NOT EXISTS (
            SELECT 1
            FROM region_import_tmp src
            WHERE src.osm_type = drm.osm_type
              AND src.osm_id = drm.osm_id
          )
      `, [region.id]);

      const orphanDeleted = await client.query(`
        DELETE FROM osm.building_contours bc
        WHERE NOT EXISTS (
          SELECT 1
          FROM public.data_region_memberships drm
          WHERE drm.osm_type = bc.osm_type
            AND drm.osm_id = bc.osm_id
        )
      `);

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
      swap.commit();

      const activeFeatureCount = Number((await client.query(`
        SELECT COUNT(*)::bigint AS total
        FROM public.data_region_memberships
        WHERE region_id = $1
      `, [region.id])).rows[0]?.total || 0);

      return {
        importedFeatureCount,
        activeFeatureCount,
        orphanDeletedCount: Number(orphanDeleted.rowCount || 0),
        pmtilesBytes: Number(fs.statSync(finalPmtilesPath).size || 0),
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
