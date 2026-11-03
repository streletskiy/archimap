require('dotenv').config({ quiet: true });

const path = require('path');
const { Client } = require('pg');
const { getDbProvider, getPostgresConnectionString } = require('../scripts/lib/postgres-config');
const {
  BUILDING_SEARCH_FTS_INSERT_SQL,
  BUILDING_SEARCH_SOURCE_INSERT_SQL,
  buildRawSearchSourceQuery,
  normalizeSearchSourceRows
} = require('../src/lib/server/services/search-index-source.service');

const DB_PROVIDER = getDbProvider(process.env);
const REASON = String(process.env.SEARCH_REBUILD_REASON || 'manual');
const BATCH_SIZE = Math.max(200, Math.min(20000, Number(process.env.SEARCH_INDEX_BATCH_SIZE || 2500)));
const RAW_SEARCH_SOURCE_BATCH_SQL = buildRawSearchSourceQuery({
  where: `
    WHERE (
      bc.osm_type > ?
      OR (bc.osm_type = ? AND bc.osm_id > ?)
    )
  `,
  orderBy: 'ORDER BY bc.osm_type ASC, bc.osm_id ASC',
  limitClause: 'LIMIT ?'
});

const { refreshPostgresSearchChanges, rebuildPostgresSearchIndex, SEARCH_PROJECTION_VERSION } = require('../src/lib/server/services/search-index-postgres.service');

function delayImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function logProgress(processed, totalContours, lastLogTs) {
  const now = Date.now();
  if (processed !== totalContours && now - lastLogTs < 1200) {
    return lastLogTs;
  }
  const percent = totalContours > 0 ? ((processed / totalContours) * 100).toFixed(1) : '100.0';
  console.log(`[search-worker] indexed: ${processed}/${totalContours} (${percent}%)`);
  return now;
}

async function rebuildWithDriver(driver, providerLabel) {
  const startedAt = Date.now();
  console.log(`[search-worker] rebuild started (${REASON}), provider=${providerLabel}, batch=${BATCH_SIZE}`);

  try {
    const totalContours = await driver.countContours();
    await driver.clearIndexes();

    if (totalContours === 0) {
      await driver.publish();
      console.log('[search-worker] rebuild finished: source is empty');
      console.log(`[search-worker] rebuild done in ${Date.now() - startedAt}ms`);
      return;
    }

    let processed = 0;
    let lastLogTs = 0;
    let cursorType = '';
    let cursorId = 0;

    while (true) {
      const rawRows = await driver.fetchRawBatch(cursorType, cursorId, BATCH_SIZE);
      if (rawRows.length === 0) break;

      const normalizedRows = normalizeSearchSourceRows(rawRows);
      await driver.insertBatch(normalizedRows);

      const lastRow = rawRows[rawRows.length - 1];
      cursorType = String(lastRow?.osm_type || '');
      cursorId = Number(lastRow?.osm_id || 0);
      processed += rawRows.length;
      lastLogTs = logProgress(processed, totalContours, lastLogTs);
      await delayImmediate();
    }

    await driver.publish();
    const totals = await driver.getTotals();
    console.log(`[search-worker] contours=${totals.contoursTotal} source=${totals.sourceTotal} fts=${totals.ftsTotal}`);
    console.log(`[search-worker] rebuild done in ${Date.now() - startedAt}ms`);
  } finally {
    await driver.close();
  }
}

async function rebuildPostgres() {
  const connectionString = getPostgresConnectionString(process.env);
  if (!connectionString) throw new Error('DATABASE_URL is required for DB_PROVIDER=postgres');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const state = await client.query('SELECT projection_version FROM public.search_index_state WHERE id = 1');
    const initialized = Number(state.rows[0]?.projection_version || 0) === SEARCH_PROJECTION_VERSION;
    const incremental = process.env.SEARCH_REBUILD_MODE === 'incremental' && initialized;
    if (incremental) {
      const count = await refreshPostgresSearchChanges(client);
      console.log(`[search-worker] incremental refresh completed: ${count} changed objects`);
    } else {
      await rebuildPostgresSearchIndex(client);
      console.log('[search-worker] complete search projection published atomically');
    }
  } finally {
    await client.end();
  }
}

function ensureSqliteSearchSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS local.architectural_info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  name TEXT,
  style TEXT,
  levels INTEGER,
  year_built INTEGER,
  architect TEXT,
  address TEXT,
  description TEXT,
  archimap_description TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(osm_type, osm_id)
);
`);

  const localInfoColumns = new Set(
    db
      .prepare('PRAGMA local.table_info(architectural_info)')
      .all()
      .map((column) => String(column?.name || '').trim())
  );
  if (!localInfoColumns.has('description')) {
    db.exec('ALTER TABLE local.architectural_info ADD COLUMN description TEXT;');
  }
  if (!localInfoColumns.has('archimap_description')) {
    db.exec('ALTER TABLE local.architectural_info ADD COLUMN archimap_description TEXT;');
  }
  if (!localInfoColumns.has('design_ref')) {
    db.exec('ALTER TABLE local.architectural_info ADD COLUMN design_ref TEXT;');
  }

  for (const [column, type] of Object.entries({ design: 'TEXT', design_year: 'INTEGER', material: 'TEXT',
    material_concrete: 'TEXT', roof_shape: 'TEXT', colour: 'TEXT', levels: 'INTEGER', year_built: 'INTEGER' })) {
    if (!localInfoColumns.has(column)) db.exec(`ALTER TABLE local.architectural_info ADD COLUMN ${column} ${type}`);
  }

  const searchSourceColumns = db.prepare('PRAGMA table_info(building_search_source)').all();
  const searchSourceColumnNames = new Set(searchSourceColumns.map((column) => String(column?.name || '').trim()));
  if (!searchSourceColumnNames.has('local_priority')) {
    db.exec('ALTER TABLE building_search_source ADD COLUMN local_priority INTEGER NOT NULL DEFAULT 0;');
  }
  if (!searchSourceColumnNames.has('design_ref')) {
    db.exec('ALTER TABLE building_search_source ADD COLUMN design_ref TEXT;');
  }

  const searchFtsColumns = db.prepare('PRAGMA table_info(building_search_fts)').all();
  const searchFtsColumnNames = new Set(searchFtsColumns.map((column) => String(column?.name || '').trim()));
  if (!searchSourceColumnNames.has('design_ref') || !searchFtsColumnNames.has('design_ref') || !searchFtsColumnNames.has('tags_text')) {
    db.exec('DROP TABLE IF EXISTS building_search_fts;');
    db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS building_search_fts
USING fts5(
  osm_key UNINDEXED,
  name,
  address,
  style,
  architect,
  design_ref,
  tags_text,
  tokenize = 'unicode61 remove_diacritics 2'
);
`);
  }
}

function createSqliteDriver() {
  const Database = require('better-sqlite3');
  const dataDir = path.join(__dirname, '..', 'data');
  const dbPath =
    String(process.env.ARCHIMAP_DB_PATH || path.join(dataDir, 'archimap.db')).trim() ||
    path.join(dataDir, 'archimap.db');
  const osmDbPath =
    String(process.env.OSM_DB_PATH || path.join(dataDir, 'osm.db')).trim() || path.join(dataDir, 'osm.db');
  const localEditsDbPath =
    String(process.env.LOCAL_EDITS_DB_PATH || path.join(dataDir, 'local-edits.db')).trim() ||
    path.join(dataDir, 'local-edits.db');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.prepare('ATTACH DATABASE ? AS osm').run(osmDbPath);
  db.prepare('ATTACH DATABASE ? AS local').run(localEditsDbPath);
  db.exec('PRAGMA osm.journal_mode = WAL;');
  db.exec('PRAGMA osm.synchronous = NORMAL;');
  db.exec('PRAGMA local.journal_mode = WAL;');
  db.exec('PRAGMA local.synchronous = NORMAL;');
  ensureSqliteSearchSchema(db);

  const countContours = db.prepare('SELECT COUNT(*) AS total FROM osm.building_contours');
  const selectRawBatch = db.prepare(RAW_SEARCH_SOURCE_BATCH_SQL);
  const insertSource = db.prepare(BUILDING_SEARCH_SOURCE_INSERT_SQL);
  const insertFts = db.prepare(BUILDING_SEARCH_FTS_INSERT_SQL);
  const countTotals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM osm.building_contours) AS contours_total,
      (SELECT COUNT(*) FROM building_search_source) AS source_total,
      (SELECT COUNT(*) FROM building_search_fts) AS fts_total
  `);

  return {
    async countContours() {
      return Number(countContours.get()?.total || 0);
    },
    async clearIndexes() {
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM building_search_fts;');
        db.exec('DELETE FROM building_search_source;');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async publish() {
      if (db.inTransaction) db.exec('COMMIT');
    },
    async fetchRawBatch(cursorType, cursorId, limit) {
      return selectRawBatch.all(cursorType, cursorType, cursorId, limit);
    },
    async insertBatch(rows) {
      if (!Array.isArray(rows) || rows.length === 0) {
        return;
      }
      try {
        for (const row of rows) {
          insertSource.run(
            row.osm_key,
            row.osm_type,
            row.osm_id,
            row.name,
            row.address,
            row.style,
            row.architect,
            row.design_ref,
            row.local_priority,
            row.center_lon,
            row.center_lat
          );
          insertFts.run(
            row.osm_key,
            row.name || '',
            row.address || '',
            row.style || '',
            row.architect || '',
            row.design_ref || '',
            row.tags_text || ''
          );
        }
      } catch (error) {
        if (db.inTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    async getTotals() {
      const row = countTotals.get() || {};
      return {
        contoursTotal: Number(row.contours_total || 0),
        sourceTotal: Number(row.source_total || 0),
        ftsTotal: Number(row.fts_total || 0)
      };
    },
    async close() {
      if (db.inTransaction) db.exec('ROLLBACK');
      db.close();
    }
  };
}

async function run() {
  if (DB_PROVIDER === 'postgres') {
    await rebuildPostgres();
    return;
  }
  await rebuildWithDriver(createSqliteDriver(), 'sqlite');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[search-worker] failed: ${String(error?.message || error)}`);
    process.exit(1);
  });
