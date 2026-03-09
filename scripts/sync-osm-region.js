require('dotenv').config({ quiet: true });

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const Database = require('better-sqlite3');
const { Client } = require('pg');

const { getDbProvider, getPostgresConnectionString } = require('./lib/postgres-config');
const { resolveRegionPmtilesPath } = require('../src/lib/server/services/data-settings.service');
const { moveFileSync } = require('../src/lib/server/utils/fs');

const DB_PROVIDER = getDbProvider(process.env);
const DATABASE_URL = getPostgresConnectionString(process.env);
const ARCHIMAP_DB_PATH = String(
  process.env.DATABASE_PATH
  || process.env.ARCHIMAP_DB_PATH
  || process.env.SQLITE_URL
  || path.join(__dirname, '..', 'data', 'archimap.db')
).trim() || path.join(__dirname, '..', 'data', 'archimap.db');
const OSM_DB_PATH = String(process.env.OSM_DB_PATH || path.join(__dirname, '..', 'data', 'osm.db')).trim() || path.join(__dirname, '..', 'data', 'osm.db');
const DATA_DIR = String(process.env.ARCHIMAP_DATA_DIR || path.join(__dirname, '..', 'data')).trim() || path.join(__dirname, '..', 'data');
const TIPPECANOE_PROGRESS_JSON = String(process.env.TIPPECANOE_PROGRESS_JSON ?? 'true').toLowerCase() === 'true';
const TIPPECANOE_PROGRESS_INTERVAL_SEC = Math.max(1, Math.min(300, Number(process.env.TIPPECANOE_PROGRESS_INTERVAL_SEC || 5)));

function parseArgs(argv) {
  const out = {
    regionId: null,
    pmtilesOnly: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '').trim();
    if (!arg) continue;
    if (arg === '--pmtiles-only') {
      out.pmtilesOnly = true;
      continue;
    }
    if (arg === '--region-id' && argv[index + 1]) {
      out.regionId = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--region-id=')) {
      out.regionId = Number(arg.slice('--region-id='.length));
    }
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

function runPythonWithCandidate(candidate, args, stdio = 'inherit', env = process.env) {
  const result = spawnSync(candidate.exe, [...candidate.prefixArgs, ...args], {
    stdio,
    shell: false,
    env
  });
  return { ok: result.status === 0, status: result.status ?? 1 };
}

function runPython(args, stdio = 'inherit', preferredCandidate = null, env = process.env) {
  if (preferredCandidate) {
    const direct = runPythonWithCandidate(preferredCandidate, args, stdio, env);
    if (direct.ok) return { ok: true, candidate: preferredCandidate };
    return { ok: false, candidate: preferredCandidate };
  }

  for (const candidate of getPythonCandidates()) {
    const result = runPythonWithCandidate(candidate, args, stdio, env);
    if (result.ok) return { ok: true, candidate };
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

  for (const candidate of candidates) {
    const check = runPython(['-c', 'import quackosm, duckdb; print("ok")'], 'ignore', candidate);
    if (check.ok) return candidate;
  }

  throw new Error(
    'Python modules quackosm/duckdb are not available. ' +
    'Install them manually, for example: "py -3 -m pip install --user quackosm duckdb".'
  );
}

function runCommand(exe, args, options = {}) {
  const result = spawnSync(exe, args, {
    stdio: options.stdio || 'inherit',
    shell: false,
    env: options.env || process.env
  });
  return { ok: result.status === 0, status: result.status ?? 1 };
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

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function createWorkspace(regionId) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `archimap-region-${Number(regionId)}-`));
}

function parseRowPayload(line) {
  const payload = JSON.parse(line);
  const osmType = String(payload?.osm_type || '').trim();
  const osmId = Number(payload?.osm_id);
  const geometryJson = String(payload?.geometry_json || '').trim();
  const minLon = Number(payload?.min_lon);
  const minLat = Number(payload?.min_lat);
  const maxLon = Number(payload?.max_lon);
  const maxLat = Number(payload?.max_lat);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) {
    throw new Error('Importer produced invalid OSM identity');
  }
  if (!geometryJson) {
    throw new Error(`Importer produced empty geometry for ${osmType}/${osmId}`);
  }
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
    throw new Error(`Importer produced invalid bounds for ${osmType}/${osmId}`);
  }
  return {
    osm_type: osmType,
    osm_id: osmId,
    tags_json: payload?.tags_json == null ? null : String(payload.tags_json),
    geometry_json: geometryJson,
    min_lon: minLon,
    min_lat: minLat,
    max_lon: maxLon,
    max_lat: maxLat
  };
}

async function* readImportRows(ndjsonPath) {
  const stream = fs.createReadStream(ndjsonPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = String(line || '').trim();
    if (!trimmed) continue;
    yield parseRowPayload(trimmed);
  }
}

async function exportImportRowsToGeojson(importPath, geojsonPath) {
  ensureDir(geojsonPath);
  const out = fs.createWriteStream(geojsonPath, { encoding: 'utf8' });
  let importedFeatureCount = 0;
  let bounds = null;

  try {
    for await (const row of readImportRows(importPath)) {
      const geometry = JSON.parse(row.geometry_json);
      const feature = {
        type: 'Feature',
        id: encodeOsmFeatureId(row.osm_type, row.osm_id),
        properties: {
          osm_id: Number(row.osm_id)
        },
        geometry
      };
      out.write(`${JSON.stringify(feature)}\n`);
      importedFeatureCount += 1;
      bounds = bounds
        ? {
          west: Math.min(bounds.west, row.min_lon),
          south: Math.min(bounds.south, row.min_lat),
          east: Math.max(bounds.east, row.max_lon),
          north: Math.max(bounds.north, row.max_lat)
        }
        : {
          west: row.min_lon,
          south: row.min_lat,
          east: row.max_lon,
          north: row.max_lat
        };
    }
  } finally {
    await new Promise((resolve, reject) => {
      out.end((error) => {
        if (error) return reject(error);
        return resolve();
      });
    });
  }

  return {
    importedFeatureCount,
    bounds
  };
}

function buildPmtilesSwap(finalPath, newBuiltPath) {
  ensureDir(finalPath);
  const backupPath = `${finalPath}.bak`;
  const hadExistingFile = fs.existsSync(finalPath);

  if (fs.existsSync(backupPath)) {
    fs.rmSync(backupPath, { force: true });
  }
  if (hadExistingFile) {
    moveFileSync(finalPath, backupPath);
  }
  moveFileSync(newBuiltPath, finalPath);

  return {
    finalPath,
    rollback() {
      try {
        if (fs.existsSync(finalPath)) {
          fs.rmSync(finalPath, { force: true });
        }
      } catch {
        // ignore rollback cleanup failure
      }
      if (hadExistingFile && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, finalPath);
      }
    },
    commit() {
      if (fs.existsSync(backupPath)) {
        try {
          fs.rmSync(backupPath, { force: true });
        } catch {
          // keep backup on disk if cleanup fails
        }
      }
    }
  };
}

async function writeRowsToNdjsonFile(filePath, rows) {
  ensureDir(filePath);
  const writer = fs.createWriteStream(filePath, { encoding: 'utf8' });
  for (const row of rows) {
    writer.write(`${JSON.stringify(row)}\n`);
  }
  await new Promise((resolve, reject) => {
    writer.end((error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
}

function buildPmtilesFromGeojson({ region, geojsonPath, outputPath }) {
  const tippecanoeExe = detectTippecanoeExecutable();
  if (!tippecanoeExe) {
    throw new Error('tippecanoe is not available. Install tippecanoe or set TIPPECANOE_BIN.');
  }

  ensureDir(outputPath);
  const tippecanoeArgs = [
    '-o', outputPath,
    '-f',
    '-l', String(region.sourceLayer || 'buildings'),
    '-Z', String(region.pmtilesMinZoom),
    '-z', String(region.pmtilesMaxZoom),
    '--read-parallel',
    '--detect-shared-borders',
    '--coalesce-densest-as-needed',
    '--extend-zooms-if-still-dropping',
    '--progress-interval', String(TIPPECANOE_PROGRESS_INTERVAL_SEC),
    geojsonPath
  ];
  if (TIPPECANOE_PROGRESS_JSON) {
    tippecanoeArgs.splice(tippecanoeArgs.length - 1, 0, '--json-progress');
  }
  const built = runCommand(tippecanoeExe, tippecanoeArgs);
  if (!built.ok) {
    throw new Error(`tippecanoe failed with exit code ${built.status}`);
  }
}

function openSqliteRegionDb() {
  ensureDir(ARCHIMAP_DB_PATH);
  ensureDir(OSM_DB_PATH);
  const db = new Database(ARCHIMAP_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.prepare('ATTACH DATABASE ? AS osm').run(OSM_DB_PATH);
  db.exec('PRAGMA osm.journal_mode = WAL;');
  db.exec('PRAGMA osm.synchronous = NORMAL;');
  return db;
}

function normalizeRegionRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    slug: String(row.slug || ''),
    name: String(row.name || ''),
    sourceType: String(row.source_type || 'extract_query'),
    sourceValue: String(row.source_value || ''),
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
  if (region.sourceType !== 'extract_query') {
    throw new Error('Only sourceType=extract_query is supported by managed region sync');
  }
  if (!region.sourceValue) {
    throw new Error('Region extract query is empty');
  }
}

function getRegionFromSqlite(regionId) {
  const db = openSqliteRegionDb();
  try {
    const row = db.prepare(`
      SELECT
        id,
        slug,
        name,
        source_type,
        source_value,
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

async function getRegionFromPostgres(regionId) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT
        id,
        slug,
        name,
        source_type,
        source_value,
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

async function applyRegionImportToSqlite({ region, ndjsonPath, builtPmtilesPath }) {
  const db = openSqliteRegionDb();
  const runMarker = new Date().toISOString();
  const finalPmtilesPath = resolveRegionPmtilesPath(DATA_DIR, region);
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

async function applyRegionImportToPostgres({ region, ndjsonPath, builtPmtilesPath }) {
  const client = new Client({ connectionString: DATABASE_URL });
  const runMarker = new Date().toISOString();
  const finalPmtilesPath = resolveRegionPmtilesPath(DATA_DIR, region);
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
          $1::timestamptz
        FROM region_import_tmp
        ON CONFLICT (osm_type, osm_id) DO UPDATE SET
          tags_json = excluded.tags_json,
          geometry_json = excluded.geometry_json,
          min_lon = excluded.min_lon,
          min_lat = excluded.min_lat,
          max_lon = excluded.max_lon,
          max_lat = excluded.max_lat,
          updated_at = excluded.updated_at
      `, [runMarker]);

      await client.query(`
        INSERT INTO public.data_region_memberships (
          region_id,
          osm_type,
          osm_id,
          created_at,
          updated_at
        )
        SELECT
          $1::bigint,
          osm_type,
          osm_id,
          $2::timestamptz,
          $2::timestamptz
        FROM region_import_tmp
        ON CONFLICT (region_id, osm_type, osm_id) DO UPDATE SET
          updated_at = excluded.updated_at
      `, [region.id, runMarker]);

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

async function exportRegionExtractToNdjson(region, outputPath) {
  const pythonCandidate = ensurePythonImporterDeps();
  const importerPath = path.join(__dirname, 'sync-osm-buildings.py');
  const env = {
    ...process.env,
    IMPORT_LIMIT: '0'
  };
  const args = [
    importerPath,
    '--extract-query', region.sourceValue,
    '--out-ndjson', outputPath
  ];
  const result = runPython(args, 'inherit', pythonCandidate, env);
  if (!result.ok) {
    throw new Error('Python importer failed for managed region sync');
  }
}

async function buildRegionPmtilesOnly(region) {
  const workspace = createWorkspace(region.id);
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const builtPmtilesPath = path.join(workspace, 'region.pmtiles');

  try {
    const finalArchivePath = resolveRegionPmtilesPath(DATA_DIR, region);
    const tempArchivePath = path.join(workspace, 'current-region-export.ndjson');
    if (DB_PROVIDER === 'postgres') {
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      try {
        const rows = await client.query(`
          SELECT bc.osm_type, bc.osm_id, bc.geometry_json, bc.min_lon, bc.min_lat, bc.max_lon, bc.max_lat
          FROM public.data_region_memberships drm
          JOIN osm.building_contours bc
            ON bc.osm_type = drm.osm_type AND bc.osm_id = drm.osm_id
          WHERE drm.region_id = $1
          ORDER BY bc.osm_type, bc.osm_id
        `, [region.id]);
        await writeRowsToNdjsonFile(
          tempArchivePath,
          rows.rows.map((row) => ({
            osm_type: row.osm_type,
            osm_id: row.osm_id,
            geometry_json: row.geometry_json,
            min_lon: row.min_lon,
            min_lat: row.min_lat,
            max_lon: row.max_lon,
            max_lat: row.max_lat
          }))
        );
      } finally {
        await client.end();
      }
    } else {
      const db = openSqliteRegionDb();
      try {
        const rows = db.prepare(`
          SELECT bc.osm_type, bc.osm_id, bc.geometry_json, bc.min_lon, bc.min_lat, bc.max_lon, bc.max_lat
          FROM data_region_memberships drm
          JOIN osm.building_contours bc
            ON bc.osm_type = drm.osm_type AND bc.osm_id = drm.osm_id
          WHERE drm.region_id = ?
          ORDER BY bc.osm_type, bc.osm_id
        `).all(region.id);
        await writeRowsToNdjsonFile(
          tempArchivePath,
          rows.map((row) => ({
            osm_type: row.osm_type,
            osm_id: row.osm_id,
            geometry_json: row.geometry_json,
            min_lon: row.min_lon,
            min_lat: row.min_lat,
            max_lon: row.max_lon,
            max_lat: row.max_lat
          }))
        );
      } finally {
        db.close();
      }
    }

    const exported = await exportImportRowsToGeojson(tempArchivePath, geojsonPath);
    if (exported.importedFeatureCount <= 0) {
      throw new Error('Region has no features, PMTiles rebuild aborted');
    }
    buildPmtilesFromGeojson({ region, geojsonPath, outputPath: builtPmtilesPath });
    const stagedSwap = buildPmtilesSwap(finalArchivePath, builtPmtilesPath);
    stagedSwap.commit();
    return {
      importedFeatureCount: exported.importedFeatureCount,
      activeFeatureCount: exported.importedFeatureCount,
      orphanDeletedCount: 0,
      pmtilesBytes: Number(fs.statSync(finalArchivePath).size || 0),
      pmtilesPath: finalArchivePath,
      bounds: exported.bounds
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function runRegionSync(region) {
  const workspace = createWorkspace(region.id);
  const importPath = path.join(workspace, 'region-import.ndjson');
  const geojsonPath = path.join(workspace, 'region-build.ndjson');
  const builtPmtilesPath = path.join(workspace, 'region.pmtiles');

  try {
    await exportRegionExtractToNdjson(region, importPath);
    const exported = await exportImportRowsToGeojson(importPath, geojsonPath);
    if (exported.importedFeatureCount <= 0) {
      throw new Error('Sync returned 0 features; keeping previous PMTiles and current data untouched');
    }

    buildPmtilesFromGeojson({ region, geojsonPath, outputPath: builtPmtilesPath });
    const dbResult = DB_PROVIDER === 'postgres'
      ? await applyRegionImportToPostgres({
        region,
        ndjsonPath: importPath,
        builtPmtilesPath
      })
      : await applyRegionImportToSqlite({
        region,
        ndjsonPath: importPath,
        builtPmtilesPath
      });

    return {
      ...dbResult,
      bounds: exported.bounds
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function loadRegion(regionId) {
  if (DB_PROVIDER === 'postgres') {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is required for DB_PROVIDER=postgres');
    }
    return getRegionFromPostgres(regionId);
  }
  return getRegionFromSqlite(regionId);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(args.regionId) || args.regionId <= 0) {
    throw new Error('Pass --region-id <id>');
  }

  const region = await loadRegion(args.regionId);
  assertRegionSupportsManagedSync(region);

  const summary = args.pmtilesOnly
    ? await buildRegionPmtilesOnly(region)
    : await runRegionSync(region);

  console.log(`SYNC_RESULT_JSON=${JSON.stringify({
    regionId: region.id,
    importedFeatureCount: summary.importedFeatureCount,
    activeFeatureCount: summary.activeFeatureCount,
    orphanDeletedCount: summary.orphanDeletedCount,
    pmtilesBytes: summary.pmtilesBytes,
    pmtilesPath: summary.pmtilesPath,
    bounds: summary.bounds || null
  })}`);
}

main().catch((error) => {
  const message = String(error?.message || error || 'Unknown managed region sync error');
  console.error(`[region-sync] ${message}`);
  process.exit(1);
});
