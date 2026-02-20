require('dotenv').config();

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const GEOFABRIK_PBF_URL = process.env.GEOFABRIK_PBF_URL || 'https://download.geofabrik.de/russia/volga-fed-district-latest.osm.pbf';
const DOWNLOAD_DIR = process.env.GEOFABRIK_DOWNLOAD_DIR || path.join(__dirname, '..', 'data', 'downloads');
const FORCE_DOWNLOAD = String(process.env.FORCE_DOWNLOAD || 'false').toLowerCase() === 'true';

function hasAria2() {
  const probe = spawnSync('aria2c', ['--version'], { stdio: 'ignore', shell: true });
  return probe.status === 0;
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function downloadWithFetch(url, outPath) {
  const response = await fetch(url, { headers: { 'User-Agent': 'archimap-sync/1.0' } });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} при скачивании ${url}`);
  }
  const nodeReadable = Readable.fromWeb(response.body);
  const fileStream = fs.createWriteStream(outPath);
  await pipeline(nodeReadable, fileStream);
}

function metaPathForFile(filePath) {
  return `${filePath}.meta.json`;
}

async function readJsonSafe(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeJson(filePath, payload) {
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function fetchRemoteMeta(url) {
  const response = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'archimap-sync/1.0' } });
  if (!response.ok) {
    throw new Error(`HEAD ${url} -> HTTP ${response.status}`);
  }
  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');
  const contentLengthRaw = response.headers.get('content-length');
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : null;
  return {
    etag: etag || null,
    lastModified: lastModified || null,
    contentLength: Number.isFinite(contentLength) ? contentLength : null
  };
}

function isFileActual(localMeta, remoteMeta) {
  if (!localMeta || !remoteMeta) return false;
  if (localMeta.etag && remoteMeta.etag) return localMeta.etag === remoteMeta.etag;
  if (localMeta.lastModified && remoteMeta.lastModified) {
    if (localMeta.lastModified !== remoteMeta.lastModified) return false;
    if (localMeta.contentLength && remoteMeta.contentLength) {
      return Number(localMeta.contentLength) === Number(remoteMeta.contentLength);
    }
    return true;
  }
  return false;
}

async function computeFileMd5(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fetchRemoteMd5(url) {
  try {
    const response = await fetch(`${url}.md5`, { headers: { 'User-Agent': 'archimap-sync/1.0' } });
    if (!response.ok) return null;
    const text = (await response.text()).trim();
    const match = text.match(/[a-fA-F0-9]{32}/);
    return match ? match[0].toLowerCase() : null;
  } catch {
    return null;
  }
}

async function verifyPbfIntegrity(url, pbfPath) {
  const remoteMd5 = await fetchRemoteMd5(url);
  if (!remoteMd5) {
    console.log('MD5 file not available, skipping checksum verification.');
    return true;
  }
  const localMd5 = await computeFileMd5(pbfPath);
  if (localMd5.toLowerCase() !== remoteMd5.toLowerCase()) {
    throw new Error(`PBF checksum mismatch: local=${localMd5}, remote=${remoteMd5}`);
  }
  console.log('PBF checksum verified.');
  return true;
}

async function downloadPbf(url, destDir, force = false, preferAria2 = true) {
  await ensureDir(destDir);
  const fileName = path.basename(new URL(url).pathname) || 'geofabrik.osm.pbf';
  const pbfPath = path.join(destDir, fileName);
  const metaPath = metaPathForFile(pbfPath);

  const hasLocal = fs.existsSync(pbfPath);
  const localMeta = await readJsonSafe(metaPath);
  let remoteMeta = null;

  if (!force && !FORCE_DOWNLOAD && hasLocal) {
    try {
      remoteMeta = await fetchRemoteMeta(url);
      if (isFileActual(localMeta, remoteMeta)) {
        try {
          await verifyPbfIntegrity(url, pbfPath);
          console.log('Local Geofabrik PBF is актуальный, download skipped.');
          return { pbfPath, changed: false };
        } catch (verifyError) {
          console.log(`Cached PBF failed checksum verification: ${String(verifyError.message || verifyError)}`);
          await removeFileIfExists(pbfPath);
          await removeFileIfExists(metaPath);
        }
      }
    } catch (error) {
      console.log(`Remote freshness check failed: ${String(error.message || error)}`);
      if (hasLocal) {
        try {
          await verifyPbfIntegrity(url, pbfPath);
          console.log('Using local PBF without redownload.');
          return { pbfPath, changed: false };
        } catch (verifyError) {
          console.log(`Cached PBF failed checksum verification: ${String(verifyError.message || verifyError)}`);
          await removeFileIfExists(pbfPath);
          await removeFileIfExists(metaPath);
        }
      }
    }
  }

  if (preferAria2 && hasAria2()) {
    console.log('Downloading PBF via aria2c...');
    const result = spawnSync('aria2c', ['-x', '16', '-s', '16', '-c', '-d', destDir, '-o', fileName, url], { stdio: 'inherit', shell: true });
    if (result.status !== 0) {
      throw new Error('aria2c завершился с ошибкой');
    }
  } else {
    console.log('aria2c не найден, использую встроенный fetch...');
    await downloadWithFetch(url, pbfPath);
  }

  if (!remoteMeta) {
    try {
      remoteMeta = await fetchRemoteMeta(url);
    } catch {
      remoteMeta = null;
    }
  }

  const stat = fs.statSync(pbfPath);
  await writeJson(metaPath, {
    sourceUrl: url,
    sizeBytes: stat.size,
    downloadedAt: new Date().toISOString(),
    etag: remoteMeta?.etag || null,
    lastModified: remoteMeta?.lastModified || null,
    contentLength: remoteMeta?.contentLength || null
  });

  await verifyPbfIntegrity(url, pbfPath);
  return { pbfPath, changed: true };
}

async function removeFileIfExists(filePath) {
  try {
    await fsp.rm(filePath, { force: true });
  } catch {
    // ignore
  }
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
  }

  for (const candidate of getPythonCandidates()) {
    const res = runPythonWithCandidate(candidate, args, stdio);
    if (res.ok) return { ok: true, candidate };
  }
  return { ok: false, candidate: null };
}

function ensurePyosmium() {
  const candidate = detectPythonCandidate();
  if (!candidate) {
    throw new Error('Python interpreter not found (python/py -3).');
  }

  const check = runPython(['-c', 'import osmium; print("ok")'], 'ignore', candidate);
  if (check.ok) return candidate;

  console.log(`Python module osmium not found, installing for ${candidate.exe} ${candidate.prefixArgs.join(' ')}`.trim());
  let installed = runPython(['-m', 'pip', 'install', 'osmium'], 'inherit', candidate).ok;
  if (!installed) {
    installed = runPython(['-m', 'pip', 'install', 'pyosmium'], 'inherit', candidate).ok;
  }
  if (!installed) {
    throw new Error('Не удалось установить модуль osmium. Установите вручную для того же Python, что запускает скрипт.');
  }

  const recheck = runPython(['-c', 'import osmium; print("ok")'], 'ignore', candidate);
  if (!recheck.ok) {
    throw new Error('Модуль osmium не импортируется после установки.');
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
  console.log(`Start Geofabrik PBF sync from: ${GEOFABRIK_PBF_URL}`);
  let { pbfPath, changed } = await downloadPbf(GEOFABRIK_PBF_URL, DOWNLOAD_DIR);
  console.log(`PBF ready: ${pbfPath}`);

  const hasContours = hasAnyContoursInDb();
  const shouldImport = changed || !hasContours;

  if (!shouldImport) {
    console.log('Geofabrik file not changed and contours already exist in DB. Import skipped.');
    return;
  }

  if (!hasContours) {
    console.log('First import: contours table is empty, importing from current PBF.');
  } else if (changed) {
    console.log('Geofabrik file updated, starting import.');
  }

  const pythonCandidate = ensurePyosmium();

  const importer = path.join(__dirname, 'sync-geofabrik-buildings-pbf.py');
  let done = runPython([importer, '--pbf', pbfPath], 'inherit', pythonCandidate).ok;
  if (!done) {
    console.log('Importer failed. Trying one forced redownload via fetch (without aria2) and retry...');
    await removeFileIfExists(pbfPath);
    await removeFileIfExists(`${pbfPath}.meta.json`);
    ({ pbfPath } = await downloadPbf(GEOFABRIK_PBF_URL, DOWNLOAD_DIR, true, false));
    console.log(`PBF re-downloaded: ${pbfPath}`);
    done = runPython([importer, '--pbf', pbfPath, '--no-count-pass'], 'inherit', pythonCandidate).ok;
  }
  if (!done) {
    throw new Error('Python importer failed after retry');
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
