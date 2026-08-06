const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { moveFileSync } = require('../../src/lib/server/utils/fs');

const NDJSON_STREAM_HIGH_WATER_MARK = 1024 * 1024;
const DEFAULT_BUILDING_LEVEL_HEIGHT_METERS = 3.2;
const DEFAULT_BUILDING_EXTRUSION_LEVELS = 1;
const DEFAULT_RENDER_HIDE_BASE_WHEN_PARTS = 0;
const REGION_WORKSPACE_PREFIX = 'archimap-region-';
const REGION_WORKSPACE_NAME_PATTERN = /^archimap-region-\d+-[^\\/]+$/;
const WORKSPACE_MARKER_FILE = '.archimap-workspace.json';
const DEFAULT_WORKSPACE_STALE_MS = 24 * 60 * 60 * 1000;
const STALE_WORKSPACE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastStaleWorkspaceSweepAt = 0;

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function resolveWorkspaceBaseDir() {
  // Use data/workspaces so sidecar containers (planetiler, osm2pgsql) sharing
  // the ./data volume can access workspace files.
  const dataDir = String(process.env.ARCHIMAP_DATA_DIR || '').trim() || path.join(__dirname, '..', '..', 'data');
  const base = path.join(dataDir, 'workspaces');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function resolveWorkspaceStaleMs(env: LooseRecord = process.env) {
  const rawHours = String(env.REGION_SYNC_WORKSPACE_STALE_HOURS || '').trim();
  if (!rawHours) return DEFAULT_WORKSPACE_STALE_MS;
  const hours = Number(rawHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    return DEFAULT_WORKSPACE_STALE_MS;
  }
  return Math.max(1, Math.min(24 * 30, hours)) * 60 * 60 * 1000;
}

function isPidAlive(pid, killRef = process.kill.bind(process)) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    killRef(numericPid, 0);
    return true;
  } catch (error) {
    return String(error?.code || '') === 'EPERM';
  }
}

function normalizeWorkspacePath(workspace) {
  return path.resolve(String(workspace || '').trim());
}

function isRegionWorkspacePath(workspace, baseDir = resolveWorkspaceBaseDir()) {
  const workspacePath = normalizeWorkspacePath(workspace);
  if (!workspacePath) return false;
  const basePath = path.resolve(baseDir);
  const relativePath = path.relative(basePath, workspacePath);
  return (
    Boolean(relativePath) &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath) &&
    !relativePath.includes(path.sep) &&
    REGION_WORKSPACE_NAME_PATTERN.test(path.basename(workspacePath))
  );
}

function readWorkspaceMarker(workspace) {
  const markerPath = path.join(workspace, WORKSPACE_MARKER_FILE);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function writeWorkspaceMarker(workspace, regionId) {
  const payload = {
    kind: 'archimap-region-sync-workspace',
    regionId: Number(regionId),
    pid: process.pid,
    createdAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(path.join(workspace, WORKSPACE_MARKER_FILE), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch {
    // The marker only improves stale cleanup; the workspace is still usable.
  }
}

function removeWorkspace(workspace, options: LooseRecord = {}) {
  const workspacePath = normalizeWorkspacePath(workspace);
  const baseDir = options.baseDir || resolveWorkspaceBaseDir();
  if (!isRegionWorkspacePath(workspacePath, baseDir)) {
    throw new Error(`Refusing to remove non-region workspace: ${workspacePath}`);
  }
  fs.rmSync(workspacePath, { recursive: true, force: true });
  return true;
}

function shouldSkipWorkspaceForActiveMarker(workspace, isPidAliveRef) {
  const marker = readWorkspaceMarker(workspace);
  const markerPid = Number(marker?.pid);
  return Number.isInteger(markerPid) && markerPid > 0 && isPidAliveRef(markerPid);
}

function cleanupStaleWorkspaces(options: LooseRecord = {}) {
  const baseDir = options.baseDir || resolveWorkspaceBaseDir();
  const staleMs = Number(options.staleMs ?? resolveWorkspaceStaleMs(options.env || process.env));
  const nowMs = Number(options.nowMs ?? Date.now());
  const isPidAliveRef = typeof options.isPidAliveRef === 'function' ? options.isPidAliveRef : isPidAlive;
  const keepPaths = new Set(
    (Array.isArray(options.keepPaths) ? options.keepPaths : [])
      .map((entry) => normalizeWorkspacePath(entry))
      .filter(Boolean)
  );
  const summary = {
    scanned: 0,
    removed: 0,
    skipped: 0,
    errors: 0
  };

  if (!Number.isFinite(staleMs) || staleMs <= 0 || !fs.existsSync(baseDir)) {
    return summary;
  }

  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(REGION_WORKSPACE_PREFIX)) continue;
    const workspacePath = path.join(baseDir, entry.name);
    if (!REGION_WORKSPACE_NAME_PATTERN.test(entry.name)) continue;
    summary.scanned += 1;

    if (keepPaths.has(normalizeWorkspacePath(workspacePath))) {
      summary.skipped += 1;
      continue;
    }

    try {
      if (shouldSkipWorkspaceForActiveMarker(workspacePath, isPidAliveRef)) {
        summary.skipped += 1;
        continue;
      }
      const stat = fs.statSync(workspacePath);
      const modifiedMs = Number(stat.mtimeMs || 0);
      if (Number.isFinite(modifiedMs) && nowMs - modifiedMs < staleMs) {
        summary.skipped += 1;
        continue;
      }
      removeWorkspace(workspacePath, { baseDir });
      summary.removed += 1;
    } catch {
      summary.errors += 1;
    }
  }

  return summary;
}

function maybeCleanupStaleWorkspaces(options: LooseRecord = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  if (!options.force && nowMs - lastStaleWorkspaceSweepAt < STALE_WORKSPACE_SWEEP_INTERVAL_MS) {
    return null;
  }
  lastStaleWorkspaceSweepAt = nowMs;
  return cleanupStaleWorkspaces({
    ...options,
    nowMs
  });
}

function createWorkspace(regionId, options: LooseRecord = {}) {
  maybeCleanupStaleWorkspaces({
    log: options.log
  });
  const workspace = fs.mkdtempSync(path.join(resolveWorkspaceBaseDir(), `archimap-region-${Number(regionId)}-`));
  writeWorkspaceMarker(workspace, regionId);
  return workspace;
}

function encodeOsmFeatureId(osmType, osmId) {
  const typeBit = osmType === 'relation' ? 1 : 0;
  return Number(osmId) * 2 + typeBit;
}

function formatOsmKey(osmType, osmId) {
  const normalizedType = String(osmType || '').trim();
  const normalizedId = Number(osmId);
  return `${normalizedType}/${Number.isFinite(normalizedId) ? Math.trunc(normalizedId) : 0}`;
}

function decodeOsmFeatureId(featureId) {
  const numericFeatureId = Number(featureId);
  if (!Number.isInteger(numericFeatureId) || numericFeatureId < 0) {
    return null;
  }
  return {
    osm_type: numericFeatureId % 2 === 1 ? 'relation' : 'way',
    osm_id: Math.trunc(numericFeatureId / 2)
  };
}

function normalizeFeatureKind(rawFeatureKind) {
  const kind = String(rawFeatureKind || '')
    .trim()
    .toLowerCase();
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
    if (
      Object.prototype.hasOwnProperty.call(tags, 'building:part') ||
      Object.prototype.hasOwnProperty.call(tags, 'building_part')
    ) {
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
  const normalizedExplicitMinHeight =
    Number.isFinite(explicitMinHeight) && explicitMinHeight > 0 ? explicitMinHeight : 0;
  const levelDerivedMinHeight = normalizedMinLevel * DEFAULT_BUILDING_LEVEL_HEIGHT_METERS;
  const renderMinHeightMeters = Math.max(normalizedExplicitMinHeight, levelDerivedMinHeight);
  const levelDerivedHeightMeters = renderMinHeightMeters + normalizedLevels * DEFAULT_BUILDING_LEVEL_HEIGHT_METERS;
  const renderHeightMeters =
    normalizedExplicitHeight != null && normalizedExplicitHeight > renderMinHeightMeters
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
  const normalizedOsmType = String(osmType || '').trim();
  const normalizedOsmKey = formatOsmKey(normalizedOsmType, osmId);
  return (
    `{"type":"Feature","id":${encodeOsmFeatureId(osmType, osmId)},` +
    `"properties":{"osm_type":${JSON.stringify(normalizedOsmType)},"osm_key":${JSON.stringify(normalizedOsmKey)},` +
    `"osm_id":${Number(osmId)},"feature_kind":"${normalizedFeatureKind}",` +
    `"render_height_m":${feature3dProperties.render_height_m},` +
    `"render_min_height_m":${feature3dProperties.render_min_height_m},` +
    `"render_hide_base_when_parts":${normalizedHideBaseWhenParts}},` +
    `"geometry":${normalizedGeometryJson}}\n`
  );
}

function formatRenderedGeojsonFeatureLine(
  osmType,
  osmId,
  geometryJson,
  featureKind,
  renderHeightM = 0,
  renderMinHeightM = 0,
  renderHideBaseWhenParts = DEFAULT_RENDER_HIDE_BASE_WHEN_PARTS
) {
  const normalizedGeometryJson = String(geometryJson || '').trim();
  if (!normalizedGeometryJson) {
    throw new Error(`Missing GeoJSON geometry for ${String(osmType || '').trim()}/${Number(osmId) || 0}`);
  }
  const normalizedFeatureKind = normalizeFeatureKind(featureKind);
  const normalizedRenderHeightM = Number.isFinite(Number(renderHeightM)) ? Number(renderHeightM) : 0;
  const normalizedRenderMinHeightM = Number.isFinite(Number(renderMinHeightM)) ? Number(renderMinHeightM) : 0;
  const normalizedHideBaseWhenParts = normalizeBinaryFlag(renderHideBaseWhenParts);
  const normalizedOsmType = String(osmType || '').trim();
  const normalizedOsmKey = formatOsmKey(normalizedOsmType, osmId);
  return (
    `{"type":"Feature","id":${encodeOsmFeatureId(osmType, osmId)},` +
    `"properties":{"osm_type":${JSON.stringify(normalizedOsmType)},"osm_key":${JSON.stringify(normalizedOsmKey)},` +
    `"osm_id":${Number(osmId)},"feature_kind":"${normalizedFeatureKind}",` +
    `"render_height_m":${normalizedRenderHeightM},` +
    `"render_min_height_m":${normalizedRenderMinHeightM},` +
    `"render_hide_base_when_parts":${normalizedHideBaseWhenParts}},"geometry":${normalizedGeometryJson}}\n`
  );
}

function normalizeGeometryWkbHex(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(text)) {
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

function parseRenderedGeojsonFeaturePayload(line) {
  const payload = JSON.parse(String(line || '').trim());
  const decodedFeatureId = decodeOsmFeatureId(payload?.id);
  const geometry = payload?.geometry;
  const properties =
    payload?.properties && typeof payload.properties === 'object' && !Array.isArray(payload.properties)
      ? payload.properties
      : {};
  if (!decodedFeatureId || !geometry || typeof geometry !== 'object') {
    throw new Error('Importer produced invalid rendered GeoJSON feature');
  }
  const featureKind = normalizeFeatureKind(properties?.feature_kind);
  const renderHeightM = Number(properties?.render_height_m);
  const renderMinHeightM = Number(properties?.render_min_height_m);
  return {
    osm_type: decodedFeatureId.osm_type,
    osm_id: decodedFeatureId.osm_id,
    feature_kind: featureKind,
    geometry_json: JSON.stringify(geometry),
    geometry,
    render_height_m: Number.isFinite(renderHeightM) ? renderHeightM : 0,
    render_min_height_m: Number.isFinite(renderMinHeightM) ? renderMinHeightM : 0,
    render_hide_base_when_parts: normalizeBinaryFlag(properties?.render_hide_base_when_parts)
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

async function* readRenderedGeojsonFeatures(ndjsonPath) {
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
          yield parseRenderedGeojsonFeaturePayload(line);
        }
        newlineIndex = bufferedLine.indexOf('\n');
      }
    }

    const trailingLine = bufferedLine.trim();
    if (trailingLine) {
      yield parseRenderedGeojsonFeaturePayload(trailingLine);
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
  decodeOsmFeatureId,
  buildFeature3dPropertiesFromTags,
  buildFeature3dPropertiesFromTagsJson,
  deriveFeatureKindFromTagsJson,
  buildPmtilesSwap,
  cleanupStaleWorkspaces,
  closeWriteStream,
  createWorkspace,
  encodeOsmFeatureId,
  ensureDir,
  formatGeojsonFeatureLine,
  formatRenderedGeojsonFeatureLine,
  isRegionWorkspacePath,
  normalizeFeatureKind,
  normalizeGeometryWkbHex,
  parseRenderedGeojsonFeaturePayload,
  parseRowPayload,
  readImportRows,
  readRenderedGeojsonFeatures,
  removeWorkspace,
  resolveWorkspaceBaseDir,
  updateBounds,
  writeStreamLine,
  writeRowsToNdjsonFile
};
