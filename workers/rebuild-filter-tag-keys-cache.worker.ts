require('dotenv').config({ quiet: true });

const path = require('path');
const { Client } = require('pg');
const { getDbProvider, getPostgresConnectionString } = require('../scripts/lib/postgres-config');
const {
  normalizeFilterTagKey,
  normalizeFilterTagKeyList
} = require('../src/lib/server/services/filter-tags.service');

const DB_PROVIDER = getDbProvider(process.env);
const reason = String(process.env.FILTER_TAG_KEYS_REBUILD_REASON || 'manual').trim() || 'manual';
const POSTGRES_SCAN_BATCH_SIZE = Math.max(
  500,
  Math.min(20_000, Number(process.env.FILTER_TAG_KEYS_REBUILD_BATCH_SIZE || 5_000))
);

function extractFilterTagKeysFromTagsJson(tagsJson) {
  const text = String(tagsJson || '').trim();
  if (!text || text[0] !== '{') return [];
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.keys(parsed)
      .map((key) => normalizeFilterTagKey(key))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function scanPostgresFilterTagKeys(client, options: LooseRecord = {}) {
  const batchSize = Math.max(1, Math.trunc(Number(options.batchSize) || POSTGRES_SCAN_BATCH_SIZE));
  const ensureHealthy = typeof options.ensureHealthy === 'function' ? options.ensureHealthy : () => {};
  const uniqueKeys = new Set();
  let cursorType = '';
  let cursorId = 0;
  let processedRows = 0;
  let lastProgressLogAt = 0;

  while (true) {
    ensureHealthy();
    const result = await client.query(
      `
      SELECT osm_type, osm_id, tags_json
      FROM osm.building_contours
      WHERE (osm_type, osm_id) > ($1::text, $2::bigint)
      ORDER BY osm_type ASC, osm_id ASC
      LIMIT $3
    `,
      [cursorType, cursorId, batchSize]
    );
    const rows = Array.isArray(result.rows) ? result.rows : [];
    if (rows.length === 0) break;

    for (const row of rows) {
      for (const key of extractFilterTagKeysFromTagsJson(row?.tags_json)) {
        uniqueKeys.add(key);
      }
    }

    processedRows += rows.length;
    const lastRow = rows[rows.length - 1];
    cursorType = String(lastRow?.osm_type || '');
    cursorId = Number(lastRow?.osm_id || 0);

    const now = Date.now();
    if (now - lastProgressLogAt >= 1000) {
      console.log(`[filter-tags] scan progress: rows=${processedRows}, keys=${uniqueKeys.size}`);
      lastProgressLogAt = now;
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  return normalizeFilterTagKeyList([...uniqueKeys]);
}

async function runPostgres() {
  const connectionString = getPostgresConnectionString(process.env);
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for DB_PROVIDER=postgres');
  }

  const startedAt = Date.now();
  const client = new Client({ connectionString });
  let connectionError = null;
  const ensureHealthy = () => {
    if (connectionError) {
      throw connectionError;
    }
  };

  client.on('error', (error) => {
    connectionError = error;
  });

  await client.connect();
  try {
    console.log(`[filter-tags] rebuild started (${reason}), provider=postgres`);
    const keys = await scanPostgresFilterTagKeys(client, {
      batchSize: POSTGRES_SCAN_BATCH_SIZE,
      ensureHealthy
    });
    ensureHealthy();

    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM filter_tag_keys_cache;');
      const inserted = await client.query(
        `
        INSERT INTO filter_tag_keys_cache (tag_key, updated_at)
        SELECT key, NOW()
        FROM unnest($1::text[]) AS key
      `,
        [keys]
      );
      await client.query('COMMIT');
      console.log(
        `[filter-tags] rebuild completed: ${Number(inserted.rowCount || 0)} keys in ${Date.now() - startedAt}ms`
      );
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      throw error;
    }
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

async function runSqlite() {
  const Database = require('better-sqlite3');
  const dbPath = String(process.env.ARCHIMAP_DB_PATH || path.join(__dirname, '..', 'data', 'archimap.db')).trim();
  const osmDbPath = String(process.env.OSM_DB_PATH || path.join(__dirname, '..', 'data', 'osm.db')).trim();
  const startedAt = Date.now();
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.prepare('ATTACH DATABASE ? AS osm').run(osmDbPath);
  db.exec('PRAGMA osm.journal_mode = WAL;');
  db.exec('PRAGMA osm.synchronous = NORMAL;');

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS filter_tag_keys_cache (
  tag_key TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

    console.log(`[filter-tags] rebuild started (${reason})`);
    const keys = db
      .prepare(
        `
      SELECT DISTINCT trim(je.key) AS tag_key
      FROM osm.building_contours bc,
           json_each(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END) AS je
      WHERE je.key IS NOT NULL
        AND trim(je.key) <> ''
      ORDER BY tag_key COLLATE NOCASE
    `
      )
      .all()
      .map((row) => String(row?.tag_key || '').trim())
      .filter(Boolean);

    const tx = db.transaction(() => {
      db.exec('DELETE FROM filter_tag_keys_cache;');
      const insert = db.prepare(`
        INSERT INTO filter_tag_keys_cache (tag_key, updated_at)
        VALUES (?, datetime('now'))
      `);
      for (const key of keys) {
        insert.run(key);
      }
    });
    tx();

    console.log(`[filter-tags] rebuild completed: ${keys.length} keys in ${Date.now() - startedAt}ms`);
  } finally {
    db.close();
  }
}

async function run() {
  if (DB_PROVIDER === 'postgres') {
    await runPostgres();
    return;
  }
  await runSqlite();
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`[filter-tags] rebuild failed: ${String(error.message || error)}`);
    process.exit(1);
  });
}

module.exports = {
  DB_PROVIDER,
  extractFilterTagKeysFromTagsJson,
  run,
  runPostgres,
  runSqlite,
  scanPostgresFilterTagKeys
};
