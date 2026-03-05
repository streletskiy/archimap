require('dotenv').config({ quiet: true });

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { Client } = require('pg');
const { getDbProvider, getPostgresConnectionString } = require('./lib/postgres-config');

const DB_PROVIDER = getDbProvider(process.env);
const OSM_PBF_PATH = String(process.env.OSM_PBF_PATH || '').trim();
const OSM_DB_PATH = String(process.env.OSM_DB_PATH || path.join(__dirname, '..', 'data', 'osm.db')).trim() || path.join(__dirname, '..', 'data', 'osm.db');
const OSM_EXTRACT_QUERY = String(process.env.OSM_EXTRACT_QUERY || '').trim();
const OSM_EXTRACT_QUERIES = parseExtractQueries(process.env.OSM_EXTRACT_QUERIES || '');
const PMTILES_ONLY = process.argv.includes('--pmtiles-only');
const PMTILES_LAYER = String(process.env.BUILDINGS_PMTILES_SOURCE_LAYER || 'buildings').trim() || 'buildings';
const PMTILES_FILE_NAME = path.basename(String(process.env.BUILDINGS_PMTILES_FILE || 'buildings.pmtiles').trim() || 'buildings.pmtiles');
const PMTILES_MIN_ZOOM = Math.max(0, Math.min(22, Number(process.env.BUILDINGS_PMTILES_MIN_ZOOM || 13)));
const PMTILES_MAX_ZOOM = Math.max(PMTILES_MIN_ZOOM, Math.min(22, Number(process.env.BUILDINGS_PMTILES_MAX_ZOOM || 16)));
const TIPPECANOE_PROGRESS_JSON = String(process.env.TIPPECANOE_PROGRESS_JSON ?? 'true').toLowerCase() === 'true';
const TIPPECANOE_PROGRESS_INTERVAL_SEC = Math.max(1, Math.min(300, Number(process.env.TIPPECANOE_PROGRESS_INTERVAL_SEC || 5)));
const IMPORT_LIMIT = Math.max(0, Number(process.env.IMPORT_LIMIT || 0) || 0);
const POSTGRES_URL = getPostgresConnectionString(process.env);

function parseExtractQueries(raw) {
  return String(raw || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

function getEffectiveExtractQueries() {
  const seen = new Set();
  const out = [];
  for (const q of [OSM_EXTRACT_QUERY, ...OSM_EXTRACT_QUERIES]) {
    const key = q.toLowerCase();
    if (!q || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

function getPythonCandidates() {
  const out = [];
  const envPython = String(process.env.PYTHON_BIN || '').trim();
  if (envPython) {
    out.push({ exe: envPython, prefixArgs: [] });
  }
  if (process.platform === 'win32') {
    out.push(
      { exe: 'py', prefixArgs: ['-3'] },
      { exe: 'python', prefixArgs: [] },
      { exe: 'python3', prefixArgs: [] }
    );
  } else {
    out.push(
      { exe: 'python3', prefixArgs: [] },
      { exe: 'python', prefixArgs: [] },
      { exe: 'py', prefixArgs: ['-3'] }
    );
  }
  return out;
}

function runPythonWithCandidate(candidate, args, stdio = 'inherit') {
  const res = spawnSync(candidate.exe, [...candidate.prefixArgs, ...args], {
    stdio,
    shell: false,
    env: process.env
  });
  return { ok: res.status === 0, status: res.status ?? 1 };
}

function runPython(args, stdio = 'inherit', preferredCandidate = null) {
  if (preferredCandidate) {
    const direct = runPythonWithCandidate(preferredCandidate, args, stdio);
    if (direct.ok) return { ok: true, candidate: preferredCandidate };
    return { ok: false, candidate: preferredCandidate };
  }

  for (const candidate of getPythonCandidates()) {
    const res = runPythonWithCandidate(candidate, args, stdio);
    if (res.ok) return { ok: true, candidate };
  }
  return { ok: false, candidate: null };
}

function ensurePythonImporterDeps() {
  const candidates = getPythonCandidates().filter((candidate) => {
    const probe = runPythonWithCandidate(candidate, ['-c', 'import sys; print(sys.executable)'], 'pipe');
    return probe.ok;
  });
  if (candidates.length === 0) {
    throw new Error('Python interpreter not found (python/py -3).');
  }

  const installErrors = [];
  const triedCandidates = [];
  for (const candidate of candidates) {
    const check = runPython(['-c', 'import quackosm, duckdb; print("ok")'], 'ignore', candidate);
    if (check.ok) return candidate;

    const pyLabel = `${candidate.exe} ${candidate.prefixArgs.join(' ')}`.trim();
    triedCandidates.push(pyLabel);
    console.log(`Python modules quackosm/duckdb not found, installing for ${pyLabel}`);
    let installed = runPython(['-m', 'pip', 'install', 'quackosm', 'duckdb'], 'inherit', candidate).ok;
    if (!installed) {
      console.log('pip install failed, trying ensurepip + user install fallback...');
      runPython(['-m', 'ensurepip', '--upgrade'], 'inherit', candidate);
      installed = runPython(['-m', 'pip', 'install', '--user', 'quackosm', 'duckdb'], 'inherit', candidate).ok;
    }
    if (!installed) {
      installErrors.push(`installer failed for ${pyLabel}`);
      continue;
    }

    const recheck = runPython(['-c', 'import quackosm, duckdb; print("ok")'], 'ignore', candidate);
    if (recheck.ok) return candidate;
    installErrors.push(`modules are not importable after install for ${pyLabel}`);
  }

  throw new Error(
    `Failed to install quackosm/duckdb for importer Python. ` +
    `Tried interpreters: ${triedCandidates.join(', ')}. ` +
    `Details: ${installErrors.join('; ')}. ` +
    `Try manually: "py -3 -m pip install --user quackosm duckdb" and rerun sync.`
  );
}

function runCommand(exe, args, options = {}) {
  const res = spawnSync(exe, args, {
    stdio: options.stdio || 'inherit',
    shell: false,
    env: process.env
  });
  return { ok: res.status === 0, status: res.status ?? 1 };
}

function detectTippecanoeExecutable() {
  const envBin = String(process.env.TIPPECANOE_BIN || '').trim();
  const candidates = envBin ? [envBin] : ['tippecanoe'];
  for (const exe of candidates) {
    const probe = runCommand(exe, ['--version'], { stdio: 'pipe' });
    if (probe.ok) return exe;
  }
  return null;
}

function encodeOsmFeatureId(osmType, osmId) {
  const typeBit = osmType === 'relation' ? 1 : 0;
  return (Number(osmId) * 2) + typeBit;
}

function buildPmtilesFromRowsIterator(rowsIteratorFactory) {
  const dataDir = path.join(__dirname, '..', 'data');
  const outPath = path.join(dataDir, PMTILES_FILE_NAME);
  const tmpInputPath = path.join(os.tmpdir(), `archimap-buildings-${Date.now()}.ndjson`);
  const fd = fs.openSync(tmpInputPath, 'w');
  let total = 0;

  return Promise.resolve()
    .then(async () => {
      try {
        for await (const row of rowsIteratorFactory()) {
          let geometry = null;
          try {
            geometry = JSON.parse(row.geometry_json);
          } catch {
            geometry = null;
          }
          if (!geometry || typeof geometry !== 'object') continue;

          const feature = {
            type: 'Feature',
            id: encodeOsmFeatureId(row.osm_type, row.osm_id),
            properties: {
              osm_id: Number(row.osm_id)
            },
            geometry
          };
          fs.writeSync(fd, `${JSON.stringify(feature)}\n`);
          total += 1;
          if (total > 0 && total % 100000 === 0) {
            console.log(`[pmtiles] export progress: ${total} features`);
          }
        }
      } finally {
        fs.closeSync(fd);
      }

      if (total === 0) {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        if (fs.existsSync(tmpInputPath)) fs.unlinkSync(tmpInputPath);
        console.log('[pmtiles] no building features in DB, removed previous PMTiles file');
        return;
      }

      const tippecanoeExe = detectTippecanoeExecutable();
      if (!tippecanoeExe) {
        throw new Error('tippecanoe is not available. Install tippecanoe or set TIPPECANOE_BIN.');
      }

      console.log(`[pmtiles] running tippecanoe for ${total} features...`);
      const tippecanoeArgs = [
        '-o', outPath,
        '-f',
        '-l', PMTILES_LAYER,
        '-Z', String(PMTILES_MIN_ZOOM),
        '-z', String(PMTILES_MAX_ZOOM),
        '--read-parallel',
        '--detect-shared-borders',
        '--coalesce-densest-as-needed',
        '--extend-zooms-if-still-dropping',
        tmpInputPath
      ];
      if (TIPPECANOE_PROGRESS_JSON) {
        tippecanoeArgs.splice(tippecanoeArgs.length - 1, 0, '--json-progress');
      }
      tippecanoeArgs.splice(tippecanoeArgs.length - 1, 0, '--progress-interval', String(TIPPECANOE_PROGRESS_INTERVAL_SEC));
      const built = runCommand(tippecanoeExe, tippecanoeArgs);
      try {
        fs.unlinkSync(tmpInputPath);
      } catch {
        // ignore temp cleanup failures
      }
      if (!built.ok) {
        throw new Error(`tippecanoe failed with exit code ${built.status}`);
      }
      console.log(`[pmtiles] generated: ${outPath}`);
    });
}

async function hasAnyContoursInSqlite() {
  try {
    const db = new Database(OSM_DB_PATH, { fileMustExist: false });
    db.exec(`
CREATE TABLE IF NOT EXISTS building_contours (
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  tags_json TEXT,
  geometry_json TEXT NOT NULL,
  min_lon REAL NOT NULL,
  min_lat REAL NOT NULL,
  max_lon REAL NOT NULL,
  max_lat REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (osm_type, osm_id)
);
`);
    const row = db.prepare('SELECT COUNT(*) AS total FROM building_contours').get();
    db.close();
    return Number(row?.total || 0) > 0;
  } catch (error) {
    console.log(`Failed to check SQLite DB state: ${String(error.message || error)}`);
    return false;
  }
}

async function hasAnyContoursInPostgres() {
  if (!POSTGRES_URL) {
    throw new Error('DATABASE_URL is required for DB_PROVIDER=postgres in sync script');
  }
  const client = new Client({ connectionString: POSTGRES_URL });
  await client.connect();
  try {
    const res = await client.query('SELECT COUNT(*)::bigint AS total FROM osm.building_contours');
    return Number(res.rows[0]?.total || 0) > 0;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

async function* sqliteContourRowsIterator() {
  const db = new Database(OSM_DB_PATH, { fileMustExist: true, readonly: true });
  let cursor = 0;
  const batchSize = 5000;
  const readBatch = db.prepare(`
    SELECT
      bc.rowid AS contour_rowid,
      bc.osm_type,
      bc.osm_id,
      bc.geometry_json
    FROM building_contours bc
    WHERE bc.rowid > ?
    ORDER BY bc.rowid
    LIMIT ?
  `);

  try {
    while (true) {
      const rows = readBatch.all(cursor, batchSize);
      if (rows.length === 0) break;
      for (const row of rows) {
        yield row;
      }
      cursor = Number(rows[rows.length - 1].contour_rowid);
    }
  } finally {
    db.close();
  }
}

async function* postgresContourRowsIterator() {
  const client = new Client({ connectionString: POSTGRES_URL });
  await client.connect();
  let lastOsmType = null;
  let lastOsmId = null;
  const batchSize = 5000;
  try {
    while (true) {
      const rows = lastOsmType == null
        ? await client.query(
          `SELECT osm_type, osm_id, geometry_json
           FROM osm.building_contours
           ORDER BY osm_type, osm_id
           LIMIT $1`,
          [batchSize]
        )
        : await client.query(
          `SELECT osm_type, osm_id, geometry_json
           FROM osm.building_contours
           WHERE (osm_type, osm_id) > ($1::text, $2::bigint)
           ORDER BY osm_type, osm_id
           LIMIT $3`,
          [lastOsmType, lastOsmId, batchSize]
        );
      if (rows.rows.length === 0) break;
      for (const row of rows.rows) {
        yield row;
      }
      const lastRow = rows.rows[rows.rows.length - 1];
      lastOsmType = String(lastRow.osm_type);
      lastOsmId = lastRow.osm_id;
    }
  } finally {
    await client.end();
  }
}

async function buildPmtilesFromSqlite() {
  console.log('[pmtiles] source=sqlite table=building_contours pagination=rowid');
  return buildPmtilesFromRowsIterator(sqliteContourRowsIterator);
}

async function buildPmtilesFromPostgres() {
  if (!POSTGRES_URL) {
    throw new Error('DATABASE_URL is required for DB_PROVIDER=postgres in sync script');
  }
  console.log('[pmtiles] source=postgres table=osm.building_contours pagination=keyset');
  return buildPmtilesFromRowsIterator(postgresContourRowsIterator);
}

async function ingestNdjsonIntoPostgres(ndjsonPath) {
  const runMarker = new Date().toISOString();
  const client = new Client({ connectionString: POSTGRES_URL });
  await client.connect();
  let imported = 0;
  let deleted = 0;
  const BATCH = 1000;

  async function flushBatch(batch) {
    if (batch.length === 0) return;
    const values = [];
    const params = [];
    let p = 1;
    for (const row of batch) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(
        String(row.osm_type),
        Number(row.osm_id),
        row.tags_json == null ? null : String(row.tags_json),
        String(row.geometry_json),
        Number(row.min_lon),
        Number(row.min_lat),
        Number(row.max_lon),
        Number(row.max_lat)
      );
    }
    await client.query(
      `INSERT INTO import_rows_tmp
         (osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat)
       VALUES ${values.join(', ')}`,
      params
    );
  }

  await client.query('BEGIN');
  try {
    await client.query(`
      CREATE TEMP TABLE import_rows_tmp (
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

    const stream = fs.createReadStream(ndjsonPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let batch = [];
    for await (const line of rl) {
      const trimmed = String(line || '').trim();
      if (!trimmed) continue;
      const row = JSON.parse(trimmed);
      batch.push(row);
      if (batch.length >= BATCH) {
        await flushBatch(batch);
        imported += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await flushBatch(batch);
      imported += batch.length;
    }

    await client.query(`
      INSERT INTO osm.building_contours
        (osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat, updated_at)
      SELECT
        osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat, $1::timestamptz
      FROM import_rows_tmp
      ON CONFLICT (osm_type, osm_id) DO UPDATE SET
        tags_json = excluded.tags_json,
        geometry_json = excluded.geometry_json,
        min_lon = excluded.min_lon,
        min_lat = excluded.min_lat,
        max_lon = excluded.max_lon,
        max_lat = excluded.max_lat,
        updated_at = excluded.updated_at
    `, [runMarker]);

    if (IMPORT_LIMIT <= 0) {
      const del = await client.query(
        'DELETE FROM osm.building_contours WHERE updated_at <> $1::timestamptz',
        [runMarker]
      );
      deleted = Number(del.rowCount || 0);
    }

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
    const total = await client.query('SELECT COUNT(*)::bigint AS total, MAX(updated_at) AS last_updated FROM osm.building_contours');
    console.log(
      `Sync done (postgres). imported=${imported}, deleted=${deleted}, total_in_db=${Number(total.rows[0]?.total || 0)}, last_updated=${total.rows[0]?.last_updated || null}`
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function runPythonImporter(args, pythonCandidate) {
  let done = runPython(args, 'inherit', pythonCandidate).ok;
  if (!done) {
    console.log('Importer failed. Retrying once...');
    done = runPython([...args, '--no-count-pass'], 'inherit', pythonCandidate).ok;
  }
  if (!done) {
    throw new Error('Python importer failed after retry');
  }
}

async function run() {
  const extractQueries = getEffectiveExtractQueries();

  if (PMTILES_ONLY) {
    console.log(`PMTiles-only mode: building tiles for provider=${DB_PROVIDER}`);
    if (DB_PROVIDER === 'postgres') {
      await buildPmtilesFromPostgres();
    } else {
      await buildPmtilesFromSqlite();
    }
    return;
  }

  const pythonCandidate = ensurePythonImporterDeps();
  const importer = path.join(__dirname, 'sync-osm-buildings.py');

  if (!OSM_PBF_PATH && extractQueries.length === 0) {
    throw new Error('Set OSM_EXTRACT_QUERY / OSM_EXTRACT_QUERIES or OSM_PBF_PATH.');
  }

  const hasContours = DB_PROVIDER === 'postgres'
    ? await hasAnyContoursInPostgres()
    : await hasAnyContoursInSqlite();

  const importArgs = [importer];
  if (extractQueries.length > 0) {
    console.log(`Start OSM extract-query sync: ${extractQueries.join(' | ')}`);
    if (!hasContours) {
      console.log('First import: contours table is empty, importing from extract query result.');
    }
    importArgs.push(...extractQueries.flatMap((query) => ['--extract-query', query]));
  } else {
    console.log(`Start OSM PBF sync from local file: ${OSM_PBF_PATH}`);
    if (!hasContours) {
      console.log('First import: contours table is empty, importing from local PBF.');
    }
    importArgs.push('--pbf', OSM_PBF_PATH);
  }

  if (DB_PROVIDER === 'postgres') {
    if (!POSTGRES_URL) {
      throw new Error('DATABASE_URL is required when DB_PROVIDER=postgres');
    }
    const tmpNdjsonPath = path.join(os.tmpdir(), `archimap-import-${Date.now()}.ndjson`);
    try {
      await runPythonImporter([...importArgs, '--out-ndjson', tmpNdjsonPath], pythonCandidate);
      await ingestNdjsonIntoPostgres(tmpNdjsonPath);
    } finally {
      try {
        fs.unlinkSync(tmpNdjsonPath);
      } catch {
        // ignore
      }
    }
    await buildPmtilesFromPostgres();
    return;
  }

  await runPythonImporter(importArgs, pythonCandidate);
  await buildPmtilesFromSqlite();
}

run().catch((error) => {
  const message = String(error?.message || error || 'Unknown sync error');
  console.error(`[sync] ${message}`);
  if (process.platform === 'win32') {
    console.error('[sync] Windows hint: install Python 3 + pip, then run "py -3 -m pip install --user quackosm duckdb".');
  }
  console.error('[sync] Docker hint: generate tiles in container with "docker compose run --rm archimap node scripts/sync-osm-buildings.js --pmtiles-only".');
  process.exit(1);
});
