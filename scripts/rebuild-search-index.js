require('dotenv').config();

const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'archimap.db');
const db = new Database(dbPath);

const REASON = String(process.env.SEARCH_REBUILD_REASON || 'manual');
const BATCH_SIZE = Math.max(200, Math.min(20000, Number(process.env.SEARCH_INDEX_BATCH_SIZE || 2500)));
const SCHEMA_VERSION = Number(process.env.SEARCH_INDEX_SCHEMA_VERSION || 1);
const FINGERPRINT_KEY = String(process.env.SEARCH_INDEX_FINGERPRINT_KEY || 'search.index.fingerprint');

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

function buildSearchDataFingerprint(snapshot) {
  return [
    `schema:${SCHEMA_VERSION}`,
    `c:${Number(snapshot?.contours_count || 0)}`,
    `cu:${String(snapshot?.contours_max_updated_at || '')}`,
    `i:${Number(snapshot?.info_count || 0)}`,
    `iu:${String(snapshot?.info_max_updated_at || '')}`
  ].join('|');
}

function getSearchFingerprintSnapshot() {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM building_contours) AS contours_count,
      (SELECT coalesce(MAX(updated_at), '') FROM building_contours) AS contours_max_updated_at,
      (SELECT COUNT(*) FROM architectural_info) AS info_count,
      (SELECT coalesce(MAX(updated_at), '') FROM architectural_info) AS info_max_updated_at
  `).get();
}

function writeMetaValue(key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(String(key), String(value ?? ''));
}

function delayImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function run() {
  const startedAt = Date.now();
  console.log(`[search-worker] rebuild started (${REASON}), batch size: ${BATCH_SIZE}`);

  const totalContours = Number(db.prepare(`SELECT COUNT(*) AS total FROM building_contours`).get()?.total || 0);

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM building_search_source;');
    db.exec('DELETE FROM building_search_fts;');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  if (totalContours === 0) {
    const fingerprint = buildSearchDataFingerprint(getSearchFingerprintSnapshot());
    writeMetaValue(FINGERPRINT_KEY, fingerprint);
    console.log('[search-worker] rebuild finished: source is empty');
    console.log(`[search-worker] rebuild done in ${Date.now() - startedAt}ms`);
    return;
  }

  const selectSourceBatch = db.prepare(`
    SELECT
      bc.rowid AS contour_rowid,
      bc.osm_type || '/' || bc.osm_id AS osm_key,
      bc.osm_type,
      bc.osm_id,
      NULLIF(trim(coalesce(ai.name,
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.name'),
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."name:ru"'),
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.official_name'),
        ''
      )), '') AS name,
      NULLIF(trim(replace(replace(replace(coalesce(ai.address,
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:full"'),
        trim(
          coalesce(json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:postcode"') || ', ', '') ||
          coalesce(json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:city"') || ', ', '') ||
          coalesce(json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:place"') || ', ', '') ||
          coalesce(json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:street"'), '') ||
          CASE
            WHEN json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:housenumber"') IS NOT NULL
              AND trim(json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:housenumber"')) <> ''
            THEN ', ' || json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."addr:housenumber"')
            ELSE ''
          END
        )
      ), ', ,', ','), ',,', ','), '  ', ' ')), '') AS address,
      NULLIF(trim(coalesce(ai.style,
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$."building:architecture"'),
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.architecture'),
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.style'),
        ''
      )), '') AS style,
      NULLIF(trim(coalesce(ai.architect,
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.architect'),
        json_extract(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END, '$.architect_name'),
        ''
      )), '') AS architect,
      (bc.min_lon + bc.max_lon) / 2.0 AS center_lon,
      (bc.min_lat + bc.max_lat) / 2.0 AS center_lat
    FROM building_contours bc
    LEFT JOIN architectural_info ai
      ON ai.osm_type = bc.osm_type AND ai.osm_id = bc.osm_id
    WHERE bc.rowid > ?
    ORDER BY bc.rowid
    LIMIT ?
  `);

  const insertSource = db.prepare(`
    INSERT INTO building_search_source (osm_key, osm_type, osm_id, name, address, style, architect, center_lon, center_lat, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let sourceProcessed = 0;
  let sourceCursor = 0;
  let lastLogTs = 0;

  while (true) {
    const rows = selectSourceBatch.all(sourceCursor, BATCH_SIZE);
    if (rows.length === 0) break;

    db.exec('BEGIN');
    try {
      for (const row of rows) {
        insertSource.run(
          row.osm_key,
          row.osm_type,
          row.osm_id,
          row.name || null,
          row.address || null,
          row.style || null,
          row.architect || null,
          row.center_lon,
          row.center_lat
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    sourceCursor = Number(rows[rows.length - 1].contour_rowid);
    sourceProcessed += rows.length;

    const now = Date.now();
    if (sourceProcessed === totalContours || now - lastLogTs >= 1200) {
      const percent = ((sourceProcessed / totalContours) * 100).toFixed(1);
      console.log(`[search-worker] source phase: ${sourceProcessed}/${totalContours} (${percent}%)`);
      lastLogTs = now;
    }
    await delayImmediate();
  }

  const totalSource = Number(db.prepare(`SELECT COUNT(*) AS total FROM building_search_source`).get()?.total || 0);
  const selectFtsBatch = db.prepare(`
    SELECT rowid AS row_id, osm_key, coalesce(name, '') AS name, coalesce(address, '') AS address, coalesce(style, '') AS style, coalesce(architect, '') AS architect
    FROM building_search_source
    WHERE rowid > ?
    ORDER BY rowid
    LIMIT ?
  `);
  const insertFts = db.prepare(`
    INSERT INTO building_search_fts (osm_key, name, address, style, architect)
    VALUES (?, ?, ?, ?, ?)
  `);

  let ftsProcessed = 0;
  let ftsCursor = 0;

  while (true) {
    const rows = selectFtsBatch.all(ftsCursor, BATCH_SIZE);
    if (rows.length === 0) break;

    db.exec('BEGIN');
    try {
      for (const row of rows) {
        insertFts.run(row.osm_key, row.name, row.address, row.style, row.architect);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    ftsCursor = Number(rows[rows.length - 1].row_id);
    ftsProcessed += rows.length;

    const now = Date.now();
    if (ftsProcessed === totalSource || now - lastLogTs >= 1200) {
      const percent = totalSource > 0 ? ((ftsProcessed / totalSource) * 100).toFixed(1) : '100.0';
      console.log(`[search-worker] fts phase: ${ftsProcessed}/${totalSource} (${percent}%)`);
      lastLogTs = now;
    }
    await delayImmediate();
  }

  const fingerprint = buildSearchDataFingerprint(getSearchFingerprintSnapshot());
  writeMetaValue(FINGERPRINT_KEY, fingerprint);
  console.log(`[search-worker] rebuild done in ${Date.now() - startedAt}ms`);
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[search-worker] failed: ${String(error?.message || error)}`);
    process.exit(1);
  });
