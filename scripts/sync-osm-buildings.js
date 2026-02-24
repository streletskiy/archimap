require('dotenv').config();

const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const OSM_PBF_PATH = String(process.env.OSM_PBF_PATH || '').trim();
const OSM_EXTRACT_QUERY = String(process.env.OSM_EXTRACT_QUERY || '').trim();
const OSM_EXTRACT_QUERIES = parseExtractQueries(process.env.OSM_EXTRACT_QUERIES || '');

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

async function run() {
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
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
