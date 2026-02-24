require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const OSM_PBF_PATH = String(process.env.OSM_PBF_PATH || '').trim();
const OSM_EXTRACT_QUERY = String(process.env.OSM_EXTRACT_QUERY || '').trim();
const OSM_EXTRACT_QUERIES = parseExtractQueries(process.env.OSM_EXTRACT_QUERIES || '');
const PMTILES_ONLY = process.argv.includes('--pmtiles-only');
const PMTILES_LAYER = String(process.env.BUILDINGS_PMTILES_SOURCE_LAYER || 'buildings').trim() || 'buildings';
const PMTILES_FILE_NAME = path.basename(String(process.env.BUILDINGS_PMTILES_FILE || 'buildings.pmtiles').trim() || 'buildings.pmtiles');
const PMTILES_MIN_ZOOM = Math.max(0, Math.min(22, Number(process.env.BUILDINGS_PMTILES_MIN_ZOOM || 13)));
const PMTILES_MAX_ZOOM = Math.max(PMTILES_MIN_ZOOM, Math.min(22, Number(process.env.BUILDINGS_PMTILES_MAX_ZOOM || 16)));
const TIPPECANOE_PROGRESS_JSON = String(process.env.TIPPECANOE_PROGRESS_JSON ?? 'true').toLowerCase() === 'true';
const TIPPECANOE_PROGRESS_INTERVAL_SEC = Math.max(1, Math.min(300, Number(process.env.TIPPECANOE_PROGRESS_INTERVAL_SEC || 5)));

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
  out.push(
    { exe: 'python3', prefixArgs: [] },
    { exe: 'python', prefixArgs: [] },
    { exe: 'py', prefixArgs: ['-3'] }
  );
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

function detectPythonCandidate() {
  for (const candidate of getPythonCandidates()) {
    const probe = runPythonWithCandidate(candidate, ['-c', 'import sys; print(sys.executable)'], 'pipe');
    if (probe.ok) {
      return candidate;
    }
  }
  return null;
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
  const candidate = detectPythonCandidate();
  if (!candidate) {
    throw new Error('Python interpreter not found (python/py -3).');
  }

  const check = runPython(['-c', 'import quackosm, duckdb; print("ok")'], 'ignore', candidate);
  if (check.ok) return candidate;

  console.log(`Python modules quackosm/duckdb not found, installing for ${candidate.exe} ${candidate.prefixArgs.join(' ')}`.trim());
  const installed = runPython(['-m', 'pip', 'install', 'quackosm', 'duckdb'], 'inherit', candidate).ok;
  if (!installed) {
    throw new Error('Failed to install quackosm/duckdb for importer Python.');
  }

  const recheck = runPython(['-c', 'import quackosm, duckdb; print("ok")'], 'ignore', candidate);
  if (!recheck.ok) {
    throw new Error('quackosm/duckdb are not importable after installation.');
  }

  return candidate;
}

function hasAnyContoursInDb() {
  try {
    const dbPath = path.join(__dirname, '..', 'data', 'archimap.db');
    const db = new Database(dbPath, { fileMustExist: false });
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
    console.log(`Failed to check DB state: ${String(error.message || error)}`);
    return false;
  }
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

function buildPmtilesFromSQLite() {
  const tippecanoeExe = detectTippecanoeExecutable();
  if (!tippecanoeExe) {
    throw new Error('tippecanoe is not available. Install tippecanoe or set TIPPECANOE_BIN.');
  }

  const dataDir = path.join(__dirname, '..', 'data');
  const dbPath = path.join(dataDir, 'archimap.db');
  const outPath = path.join(dataDir, PMTILES_FILE_NAME);
  const tmpInputPath = path.join(os.tmpdir(), `archimap-buildings-${Date.now()}.ndjson`);

  const db = new Database(dbPath, { fileMustExist: true, readonly: true });
  const fd = fs.openSync(tmpInputPath, 'w');
  let total = 0;
  let cursor = 0;
  const batchSize = 5000;

  try {
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

    while (true) {
      const rows = readBatch.all(cursor, batchSize);
      if (rows.length === 0) break;
      for (const row of rows) {
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
      }
      cursor = Number(rows[rows.length - 1].contour_rowid);
      if (total > 0 && total % 100000 < rows.length) {
        console.log(`[pmtiles] export progress: ${total} features`);
      }
    }
  } finally {
    db.close();
    fs.closeSync(fd);
  }

  if (total === 0) {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    if (fs.existsSync(tmpInputPath)) fs.unlinkSync(tmpInputPath);
    console.log('[pmtiles] no building features in DB, removed previous PMTiles file');
    return;
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
}

async function run() {
  if (PMTILES_ONLY) {
    console.log('PMTiles-only mode: building tiles from existing SQLite contours');
    buildPmtilesFromSQLite();
    return;
  }

  const extractQueries = getEffectiveExtractQueries();
  const hasContours = hasAnyContoursInDb();
  const pythonCandidate = ensurePythonImporterDeps();
  const importer = path.join(__dirname, 'sync-osm-buildings.py');

  if (!OSM_PBF_PATH && extractQueries.length === 0) {
    throw new Error('Set OSM_EXTRACT_QUERY / OSM_EXTRACT_QUERIES or OSM_PBF_PATH.');
  }

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

  let done = runPython(importArgs, 'inherit', pythonCandidate).ok;
  if (!done) {
    console.log('Importer failed. Retrying once...');
    done = runPython([...importArgs, '--no-count-pass'], 'inherit', pythonCandidate).ok;
  }
  if (!done) {
    throw new Error('Python importer failed after retry');
  }

  buildPmtilesFromSQLite();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
