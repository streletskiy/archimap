const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { moveFileSync } = require('../../src/lib/server/utils/fs');

const NDJSON_STREAM_HIGH_WATER_MARK = 1024 * 1024;
const DEFAULT_BUILDING_LEVEL_HEIGHT_METERS = 3.2;
const DEFAULT_BUILDING_EXTRUSION_LEVELS = 1;
const DEFAULT_RENDER_HIDE_BASE_WHEN_PARTS = 0;

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

function normalizeFeatureKind(rawFeatureKind) {
  const kind = String(rawFeatureKind || '').trim().toLowerCase();
  if (kind === 'building_remainder') return 'building_remainder';
  return kind === 'building_part' ? 'building_part' : 'building';
}

function deriveFeatureKindFromTagsJson(tagsJson) {
  const text = String(tagsJson || '').trim();
  if (!text) return 'building';
  try {
    const tags = JSON.parse(text);
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return 'building';
    if (Object.prototype.hasOwnProperty.call(tags, 'building')) {
      return 'building';
    }
    if (Object.prototype.hasOwnProperty.call(tags, 'building:part') || Object.prototype.hasOwnProperty.call(tags, 'building_part')) {
      return 'building_part';
    }
  } catch {
    return 'building';
  }
  return 'building';
}

function parseTagsJsonObject(tagsJson) {
  const text = String(tagsJson || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function roundMeterValue(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return 0;
  return Math.round(Math.max(0, normalized) * 100) / 100;
}

function normalizeBinaryFlag(value) {
  return Number(value) > 0 ? 1 : 0;
}

function parseTagNumber(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.replace(',', '.');
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function readFirstNumericTag(tags, keys = []) {
  for (const key of Array.isArray(keys) ? keys : []) {
    if (!Object.prototype.hasOwnProperty.call(tags || {}, key)) continue;
    const value = parseTagNumber(tags?.[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function buildFeature3dPropertiesFromTags(tags = {}) {
  const levels = readFirstNumericTag(tags, ['building:levels', 'levels']);
  const explicitHeight = readFirstNumericTag(tags, ['building:height', 'height']);
  const minLevel = readFirstNumericTag(tags, ['building:min_level', 'min_level']);
  const explicitMinHeight = readFirstNumericTag(tags, ['building:min_height', 'min_height']);
  const normalizedLevels = Number.isFinite(levels) && levels > 0 ? levels : DEFAULT_BUILDING_EXTRUSION_LEVELS;
  const normalizedExplicitHeight = Number.isFinite(explicitHeight) && explicitHeight > 0 ? explicitHeight : null;
  const normalizedMinLevel = Number.isFinite(minLevel) && minLevel > 0 ? minLevel : 0;
  const normalizedExplicitMinHeight = Number.isFinite(explicitMinHeight) && explicitMinHeight > 0
    ? explicitMinHeight
    : 0;
  const levelDerivedMinHeight = normalizedMinLevel * DEFAULT_BUILDING_LEVEL_HEIGHT_METERS;
  const renderMinHeightMeters = Math.max(normalizedExplicitMinHeight, levelDerivedMinHeight);
  const levelDerivedHeightMeters = renderMinHeightMeters + (normalizedLevels * DEFAULT_BUILDING_LEVEL_HEIGHT_METERS);
  const renderHeightMeters = normalizedExplicitHeight != null && normalizedExplicitHeight > renderMinHeightMeters
    ? normalizedExplicitHeight
    : levelDerivedHeightMeters;

  return {
    render_height_m: roundMeterValue(renderHeightMeters),
    render_min_height_m: roundMeterValue(renderMinHeightMeters)
  };
}

function buildFeature3dPropertiesFromTagsJson(tagsJson) {
  return buildFeature3dPropertiesFromTags(parseTagsJsonObject(tagsJson));
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

function formatGeojsonFeatureLine(
  osmType,
  osmId,
  geometryJson,
  tagsJson = null,
  featureKind = null,
  renderHideBaseWhenParts = DEFAULT_RENDER_HIDE_BASE_WHEN_PARTS
) {
  const normalizedGeometryJson = String(geometryJson || '').trim();
  if (!normalizedGeometryJson) {
    throw new Error(`Missing GeoJSON geometry for ${String(osmType || '').trim()}/${Number(osmId) || 0}`);
  }
  const normalizedFeatureKind = normalizeFeatureKind(featureKind || deriveFeatureKindFromTagsJson(tagsJson));
  const feature3dProperties = buildFeature3dPropertiesFromTagsJson(tagsJson);
  const normalizedHideBaseWhenParts = normalizeBinaryFlag(renderHideBaseWhenParts);
  return (
    `{"type":"Feature","id":${encodeOsmFeatureId(osmType, osmId)},` +
    `"properties":{"osm_id":${Number(osmId)},"feature_kind":"${normalizedFeatureKind}",` +
    `"render_height_m":${feature3dProperties.render_height_m},` +
    `"render_min_height_m":${feature3dProperties.render_min_height_m},` +
    `"render_hide_base_when_parts":${normalizedHideBaseWhenParts}},` +
    `"geometry":${normalizedGeometryJson}}\n`
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

function parseRowPayload(line, options: LooseRecord = {}) {
  const payload = JSON.parse(line);
  const osmType = String(payload?.osm_type || '').trim();
  const osmId = Number(payload?.osm_id);
  const geometryJson = String(payload?.geometry_json || '').trim();
  const geometryWkbHex = normalizeGeometryWkbHex(payload?.geometry_wkb_hex);
  const featureKind = normalizeFeatureKind(payload?.feature_kind || deriveFeatureKindFromTagsJson(payload?.tags_json));
  const minLon = Number(payload?.min_lon);
  const minLat = Number(payload?.min_lat);
  const maxLon = Number(payload?.max_lon);
  const maxLat = Number(payload?.max_lat);
  const renderHideBaseWhenParts = normalizeBinaryFlag(payload?.render_hide_base_when_parts);
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
    feature_kind: featureKind,
    geometry_json: geometryJson || null,
    geometry_wkb_hex: geometryWkbHex,
    min_lon: minLon,
    min_lat: minLat,
    max_lon: maxLon,
    max_lat: maxLat,
    render_hide_base_when_parts: renderHideBaseWhenParts
  };
}

async function* readImportRows(ndjsonPath, options: LooseRecord = {}) {
  const stream = fs.createReadStream(ndjsonPath, {
    encoding: 'utf8',
    highWaterMark: NDJSON_STREAM_HIGH_WATER_MARK
  });
  let bufferedLine = '';

  try {
    for await (const chunk of stream) {
      bufferedLine += String(chunk || '');

      let newlineIndex = bufferedLine.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = bufferedLine.slice(0, newlineIndex).trim();
        bufferedLine = bufferedLine.slice(newlineIndex + 1);
        if (line) {
          yield parseRowPayload(line, options);
        }
        newlineIndex = bufferedLine.indexOf('\n');
      }
    }

    const trailingLine = bufferedLine.trim();
    if (trailingLine) {
      yield parseRowPayload(trailingLine, options);
    }
  } finally {
    stream.destroy();
  }
}

async function writeStreamLine(writer, line) {
  if (writer.write(line)) {
    return;
  }
  await once(writer, 'drain');
}

async function closeWriteStream(writer) {
  await new Promise<void>((resolve, reject) => {
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
  buildFeature3dPropertiesFromTags,
  buildFeature3dPropertiesFromTagsJson,
  deriveFeatureKindFromTagsJson,
  buildPmtilesSwap,
  closeWriteStream,
  createWorkspace,
  encodeOsmFeatureId,
  ensureDir,
  formatGeojsonFeatureLine,
  normalizeFeatureKind,
  normalizeGeometryWkbHex,
  parseRowPayload,
  readImportRows,
  updateBounds,
  writeStreamLine,
  writeRowsToNdjsonFile
};
