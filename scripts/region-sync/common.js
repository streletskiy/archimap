const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { once } = require('events');
const { moveFileSync } = require('../../src/lib/server/utils/fs');

const NDJSON_STREAM_HIGH_WATER_MARK = 1024 * 1024;

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

function updateBounds(bounds, row) {
  if (!row) return bounds;
  if (!bounds) {
    return {
      west: row.min_lon,
      south: row.min_lat,
      east: row.max_lon,
      north: row.max_lat
    };
  }
  return {
    west: Math.min(bounds.west, row.min_lon),
    south: Math.min(bounds.south, row.min_lat),
    east: Math.max(bounds.east, row.max_lon),
    north: Math.max(bounds.north, row.max_lat)
  };
}

function formatGeojsonFeatureLine(osmType, osmId, geometryJson) {
  const normalizedGeometryJson = String(geometryJson || '').trim();
  if (!normalizedGeometryJson) {
    throw new Error(`Missing GeoJSON geometry for ${String(osmType || '').trim()}/${Number(osmId) || 0}`);
  }
  return (
    `{"type":"Feature","id":${encodeOsmFeatureId(osmType, osmId)},` +
    `"properties":{"osm_id":${Number(osmId)}},"geometry":${normalizedGeometryJson}}\n`
  );
}

function normalizeGeometryWkbHex(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if ((text.length % 2) !== 0 || !/^[0-9a-fA-F]+$/.test(text)) {
    return null;
  }
  return text.toUpperCase();
}

function parseRowPayload(line, options = {}) {
  const payload = JSON.parse(line);
  const osmType = String(payload?.osm_type || '').trim();
  const osmId = Number(payload?.osm_id);
  const geometryJson = String(payload?.geometry_json || '').trim();
  const geometryWkbHex = normalizeGeometryWkbHex(payload?.geometry_wkb_hex);
  const minLon = Number(payload?.min_lon);
  const minLat = Number(payload?.min_lat);
  const maxLon = Number(payload?.max_lon);
  const maxLat = Number(payload?.max_lat);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) {
    throw new Error('Importer produced invalid OSM identity');
  }
  const requireGeometryJson = Boolean(options.requireGeometryJson);
  const requireGeometryWkbHex = Boolean(options.requireGeometryWkbHex);
  if (requireGeometryJson && !geometryJson) {
    throw new Error(`Importer produced empty GeoJSON geometry for ${osmType}/${osmId}`);
  }
  if (requireGeometryWkbHex && !geometryWkbHex) {
    throw new Error(`Importer produced empty WKB geometry for ${osmType}/${osmId}`);
  }
  if (!geometryJson && !geometryWkbHex) {
    throw new Error(`Importer produced empty geometry for ${osmType}/${osmId}`);
  }
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
    throw new Error(`Importer produced invalid bounds for ${osmType}/${osmId}`);
  }
  return {
    osm_type: osmType,
    osm_id: osmId,
    tags_json: payload?.tags_json == null ? null : String(payload.tags_json),
    geometry_json: geometryJson || null,
    geometry_wkb_hex: geometryWkbHex,
    min_lon: minLon,
    min_lat: minLat,
    max_lon: maxLon,
    max_lat: maxLat
  };
}

async function* readImportRows(ndjsonPath, options = {}) {
  const stream = fs.createReadStream(ndjsonPath, {
    encoding: 'utf8',
    highWaterMark: NDJSON_STREAM_HIGH_WATER_MARK
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = String(line || '').trim();
    if (!trimmed) continue;
    yield parseRowPayload(trimmed, options);
  }
}

async function writeStreamLine(writer, line) {
  if (writer.write(line)) {
    return;
  }
  await once(writer, 'drain');
}

async function closeWriteStream(writer) {
  await new Promise((resolve, reject) => {
    writer.end((error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
}

async function writeRowsToNdjsonFile(filePath, rows) {
  ensureDir(filePath);
  const writer = fs.createWriteStream(filePath, {
    encoding: 'utf8',
    highWaterMark: NDJSON_STREAM_HIGH_WATER_MARK
  });
  for (const row of rows) {
    await writeStreamLine(writer, `${JSON.stringify(row)}\n`);
  }
  await closeWriteStream(writer);
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
  closeWriteStream,
  createWorkspace,
  encodeOsmFeatureId,
  ensureDir,
  formatGeojsonFeatureLine,
  normalizeGeometryWkbHex,
  parseRowPayload,
  readImportRows,
  updateBounds,
  writeStreamLine,
  writeRowsToNdjsonFile
};
