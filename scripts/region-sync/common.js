const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { moveFileSync } = require('../../src/lib/server/utils/fs');

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function createWorkspace(regionId) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `archimap-region-${Number(regionId)}-`));
}

function encodeOsmFeatureId(osmType, osmId) {
  const typeBit = osmType === 'relation' ? 1 : 0;
  return (Number(osmId) * 2) + typeBit;
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

module.exports = {
  buildPmtilesSwap,
  createWorkspace,
  encodeOsmFeatureId,
  ensureDir,
  parseRowPayload,
  readImportRows,
  writeRowsToNdjsonFile
};
