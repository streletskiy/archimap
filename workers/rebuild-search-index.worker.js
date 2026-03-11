require('dotenv').config({ quiet: true });

const os = require('os');
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
const DEFAULT_POSTGRES_PARALLEL_CHUNKS = Math.max(
  1,
  Math.min(2, Math.floor((typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length || 2) / 2))
);
const POSTGRES_PARALLEL_CHUNKS = Math.max(
  1,
  Math.min(4, Number(process.env.SEARCH_INDEX_POSTGRES_CHUNKS || DEFAULT_POSTGRES_PARALLEL_CHUNKS))
);

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

const POSTGRES_SOURCE_INSERT_SELECT_SQL = `
  INSERT INTO building_search_source (
    osm_key,
    osm_type,
    osm_id,
    name,
    address,
    style,
    architect,
    local_priority,
    center_lon,
    center_lat,
    updated_at
  )
  WITH base AS MATERIALIZED (
    SELECT
      bc.osm_type,
      bc.osm_id,
      CASE
        WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb
        ELSE '{}'::jsonb
      END AS tags_jsonb,
      NULLIF(btrim(ai.name), '') AS local_name,
      NULLIF(btrim(ai.address), '') AS local_address,
      NULLIF(btrim(ai.style), '') AS local_style,
      NULLIF(btrim(ai.architect), '') AS local_architect,
      CASE WHEN ai.osm_id IS NOT NULL THEN 1 ELSE 0 END AS local_priority,
      COALESCE((bc.min_lon + bc.max_lon) / 2.0, 0) AS center_lon,
      COALESCE((bc.min_lat + bc.max_lat) / 2.0, 0) AS center_lat
    FROM osm.building_contours bc
    LEFT JOIN local.architectural_info ai
      ON ai.osm_type = bc.osm_type
     AND ai.osm_id = bc.osm_id
    WHERE bc.osm_id BETWEEN $1 AND $2
      AND bc.osm_type IN ('way', 'relation')
      AND bc.osm_id > 0
  )
  SELECT
    base.osm_type || '/' || base.osm_id::text AS osm_key,
    base.osm_type,
    base.osm_id,
    COALESCE(
      base.local_name,
      NULLIF(btrim(base.tags_jsonb ->> 'name'), ''),
      NULLIF(btrim(base.tags_jsonb ->> 'name:ru'), ''),
      NULLIF(btrim(base.tags_jsonb ->> 'official_name'), '')
    ) AS name,
    COALESCE(
      base.local_address,
      NULLIF(btrim(base.tags_jsonb ->> 'addr:full'), ''),
      (
        SELECT string_agg(address_parts.part, ', ' ORDER BY address_parts.ord)
        FROM (
          SELECT DISTINCT ON (lower(parts.part))
            parts.ord,
            parts.part
          FROM (
            VALUES
              (1, NULLIF(btrim(base.tags_jsonb ->> 'addr:postcode'), '')),
              (2, NULLIF(btrim(base.tags_jsonb ->> 'addr:city'), '')),
              (3, NULLIF(btrim(base.tags_jsonb ->> 'addr:place'), '')),
              (4, NULLIF(btrim(base.tags_jsonb ->> 'addr:street'), '')),
              (5, NULLIF(btrim(base.tags_jsonb ->> 'addr:housenumber'), ''))
          ) AS parts(ord, part)
          WHERE parts.part IS NOT NULL
          ORDER BY lower(parts.part), parts.ord
        ) AS address_parts
      )
    ) AS address,
    COALESCE(
      base.local_style,
      NULLIF(btrim(base.tags_jsonb ->> 'building:architecture'), ''),
      NULLIF(btrim(base.tags_jsonb ->> 'architecture'), ''),
      NULLIF(btrim(base.tags_jsonb ->> 'style'), '')
    ) AS style,
    COALESCE(
      base.local_architect,
      NULLIF(btrim(base.tags_jsonb ->> 'architect'), ''),
      NULLIF(btrim(base.tags_jsonb ->> 'architect_name'), '')
    ) AS architect,
    base.local_priority,
    base.center_lon,
    base.center_lat,
    NOW() AS updated_at
  FROM base
`;

const POSTGRES_FTS_POPULATE_SQL = `
  INSERT INTO building_search_fts (
    osm_key,
    name,
    address,
    style,
    architect
  )
  SELECT
    osm_key,
    COALESCE(name, '') AS name,
    COALESCE(address, '') AS address,
    COALESCE(style, '') AS style,
    COALESCE(architect, '') AS architect
  FROM building_search_source
`;

const POSTGRES_CREATE_FTS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_building_search_fts_tsv
    ON public.building_search_fts
    USING GIN (search_tsv)
`;

function delayImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function logProgress(processed, totalContours, lastLogTs) {
  const now = Date.now();
  if (processed !== totalContours && (now - lastLogTs) < 1200) {
    return lastLogTs;
  }
  const percent = totalContours > 0
    ? ((processed / totalContours) * 100).toFixed(1)
    : '100.0';
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

    const totals = await driver.getTotals();
    console.log(`[search-worker] contours=${totals.contoursTotal} source=${totals.sourceTotal} fts=${totals.ftsTotal}`);
    console.log(`[search-worker] rebuild done in ${Date.now() - startedAt}ms`);
  } finally {
    await driver.close();
  }
}

function createProgressTracker(totalContours) {
  let processed = 0;
  let lastLogTs = 0;

  return {
    advance(count) {
      processed += Number(count || 0);
      lastLogTs = logProgress(processed, totalContours, lastLogTs);
    },
    getProcessed() {
      return processed;
    }
  };
}

function splitOsmIdRange(minOsmId, maxOsmId, chunkCount = POSTGRES_PARALLEL_CHUNKS) {
  const ranges = [];
  const normalizedChunkCount = Math.max(1, Number(chunkCount) || POSTGRES_PARALLEL_CHUNKS);
  const normalizedMin = Number(minOsmId || 0);
  const normalizedMax = Number(maxOsmId || 0);

  if (!Number.isFinite(normalizedMin) || !Number.isFinite(normalizedMax) || normalizedMin > normalizedMax) {
    for (let index = 0; index < normalizedChunkCount; index += 1) {
      ranges.push({
        chunkIndex: index + 1,
        minOsmId: 1,
        maxOsmId: 0
      });
    }
    return ranges;
  }

  const span = normalizedMax - normalizedMin + 1;
  const baseChunkSize = Math.floor(span / normalizedChunkCount);
  const remainder = span % normalizedChunkCount;
  let cursor = normalizedMin;

  for (let index = 0; index < normalizedChunkCount; index += 1) {
    const chunkSize = baseChunkSize + (index < remainder ? 1 : 0);
    const minValue = cursor;
    const maxValue = chunkSize > 0 ? cursor + chunkSize - 1 : cursor - 1;

    ranges.push({
      chunkIndex: index + 1,
      minOsmId: minValue,
      maxOsmId: maxValue
    });

    cursor = maxValue + 1;
  }

  return ranges;
}

async function createPostgresClient() {
  const connectionString = getPostgresConnectionString(process.env);
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for DB_PROVIDER=postgres');
  }

  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function clearPostgresIndexes(client) {
  await client.query('BEGIN');
  try {
    await client.query('TRUNCATE TABLE building_search_fts, building_search_source;');
    await client.query('DROP INDEX IF EXISTS idx_building_search_fts_tsv;');
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failures
    }
    throw error;
  }
}

async function populatePostgresFts(client) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL synchronous_commit = 'off'");
    await client.query(POSTGRES_FTS_POPULATE_SQL);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failures
    }
    throw error;
  }
}

async function processPostgresChunk(range, progressTracker) {
  const { chunkIndex, minOsmId, maxOsmId } = range || {};
  if (!Number.isFinite(minOsmId) || !Number.isFinite(maxOsmId) || minOsmId > maxOsmId) {
    console.log(`[search-worker] chunk ${chunkIndex} skipped (empty range)`);
    return;
  }

  const client = await createPostgresClient();
  console.log(`[search-worker] chunk ${chunkIndex} started (${minOsmId}..${maxOsmId})`);

  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL synchronous_commit = 'off'");
    const result = await client.query(POSTGRES_SOURCE_INSERT_SELECT_SQL, [minOsmId, maxOsmId]);
    await client.query('COMMIT');
    const inserted = Number(result.rowCount || 0);
    progressTracker.advance(inserted);
    console.log(`[search-worker] chunk ${chunkIndex} inserted ${inserted} rows`);
  } finally {
    await client.end();
    console.log(`[search-worker] chunk ${chunkIndex} finished (${minOsmId}..${maxOsmId})`);
  }
}

async function getPostgresTotals(client) {
  const result = await client.query(`
    SELECT
      (SELECT COUNT(*)::bigint FROM osm.building_contours) AS contours_total,
      (SELECT COUNT(*)::bigint FROM building_search_source) AS source_total,
      (SELECT COUNT(*)::bigint FROM building_search_fts) AS fts_total
  `);
  const row = result.rows[0] || {};
  return {
    contoursTotal: Number(row.contours_total || 0),
    sourceTotal: Number(row.source_total || 0),
    ftsTotal: Number(row.fts_total || 0)
  };
}

async function rebuildPostgresInParallel() {
  const startedAt = Date.now();
  console.log(
    `[search-worker] rebuild started (${REASON}), provider=postgres, mode=sql, chunks=${POSTGRES_PARALLEL_CHUNKS}`
  );

  const client = await createPostgresClient();

  try {
    const stats = await client.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE osm_type IN ('way', 'relation')
            AND osm_id > 0
        )::bigint AS total,
        MIN(osm_id)::bigint AS min_osm_id,
        MAX(osm_id)::bigint AS max_osm_id
      FROM osm.building_contours
    `);
    const row = stats.rows[0] || {};
    const totalContours = Number(row.total || 0);

    await clearPostgresIndexes(client);

    if (totalContours === 0) {
      console.log('[search-worker] rebuild finished: source is empty');
      console.log(`[search-worker] rebuild done in ${Date.now() - startedAt}ms`);
      return;
    }

    const minOsmId = Number(row.min_osm_id || 0);
    const maxOsmId = Number(row.max_osm_id || 0);
    const ranges = splitOsmIdRange(minOsmId, maxOsmId, POSTGRES_PARALLEL_CHUNKS);
    const progressTracker = createProgressTracker(totalContours);

    await Promise.all(ranges.map((range) => processPostgresChunk(range, progressTracker)));
    await populatePostgresFts(client);
    await client.query(POSTGRES_CREATE_FTS_INDEX_SQL);
    await client.query('ANALYZE building_search_source;');
    await client.query('ANALYZE building_search_fts;');

    const totals = await getPostgresTotals(client);
    console.log(`[search-worker] contours=${totals.contoursTotal} source=${totals.sourceTotal} fts=${totals.ftsTotal}`);
    console.log(`[search-worker] rebuild done in ${Date.now() - startedAt}ms`);
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
    db.prepare('PRAGMA local.table_info(architectural_info)').all().map((column) => String(column?.name || '').trim())
  );
  if (!localInfoColumns.has('description')) {
    db.exec('ALTER TABLE local.architectural_info ADD COLUMN description TEXT;');
  }
  if (!localInfoColumns.has('archimap_description')) {
    db.exec('ALTER TABLE local.architectural_info ADD COLUMN archimap_description TEXT;');
  }

  const searchSourceColumns = db.prepare('PRAGMA table_info(building_search_source)').all();
  const searchSourceColumnNames = new Set(searchSourceColumns.map((column) => String(column?.name || '').trim()));
  if (!searchSourceColumnNames.has('local_priority')) {
    db.exec('ALTER TABLE building_search_source ADD COLUMN local_priority INTEGER NOT NULL DEFAULT 0;');
  }
}

function createSqliteDriver() {
  const Database = require('better-sqlite3');
  const dataDir = path.join(__dirname, '..', 'data');
  const dbPath = String(process.env.ARCHIMAP_DB_PATH || path.join(dataDir, 'archimap.db')).trim() || path.join(dataDir, 'archimap.db');
  const osmDbPath = String(process.env.OSM_DB_PATH || path.join(dataDir, 'osm.db')).trim() || path.join(dataDir, 'osm.db');
  const localEditsDbPath = String(process.env.LOCAL_EDITS_DB_PATH || path.join(dataDir, 'local-edits.db')).trim() || path.join(dataDir, 'local-edits.db');
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
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async fetchRawBatch(cursorType, cursorId, limit) {
      return selectRawBatch.all(cursorType, cursorType, cursorId, limit);
    },
    async insertBatch(rows) {
      if (!Array.isArray(rows) || rows.length === 0) {
        return;
      }
      db.exec('BEGIN');
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
            row.local_priority,
            row.center_lon,
            row.center_lat
          );
          insertFts.run(
            row.osm_key,
            row.name || '',
            row.address || '',
            row.style || '',
            row.architect || ''
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
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
      db.close();
    }
  };
}

async function run() {
  if (DB_PROVIDER === 'postgres') {
    await rebuildPostgresInParallel();
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
