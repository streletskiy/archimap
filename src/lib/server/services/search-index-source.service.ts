const { getFeatureKindFromTagsJson } = require('../utils/building-feature-kind');

const SEARCH_SOURCE_RAW_SELECT_FIELDS = `
  bc.osm_type AS osm_type,
  bc.osm_id AS osm_id,
  bc.tags_json AS tags_json,
  ai.name AS local_name,
  ai.address AS local_address,
  ai.style AS local_style,
  ai.architect AS local_architect,
  CASE WHEN ai.osm_id IS NOT NULL THEN 1 ELSE 0 END AS local_priority,
  (bc.min_lon + bc.max_lon) / 2.0 AS center_lon,
  (bc.min_lat + bc.max_lat) / 2.0 AS center_lat
`;

const SEARCH_SOURCE_BASE_FROM_SQL = `
  FROM osm.building_contours bc
  LEFT JOIN local.architectural_info ai
    ON ai.osm_type = bc.osm_type
   AND ai.osm_id = bc.osm_id
`;

const BUILDING_SEARCH_SOURCE_INSERT_SQL = `
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
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`;

const BUILDING_SEARCH_SOURCE_UPSERT_SQL = `
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
  VALUES (
    @osm_key,
    @osm_type,
    @osm_id,
    @name,
    @address,
    @style,
    @architect,
    @local_priority,
    @center_lon,
    @center_lat,
    datetime('now')
  )
  ON CONFLICT(osm_key) DO UPDATE SET
    name = excluded.name,
    address = excluded.address,
    style = excluded.style,
    architect = excluded.architect,
    local_priority = excluded.local_priority,
    center_lon = excluded.center_lon,
    center_lat = excluded.center_lat,
    updated_at = datetime('now')
`;

const BUILDING_SEARCH_SOURCE_DELETE_SQL = `
  DELETE FROM building_search_source
  WHERE osm_key = ?
`;

const BUILDING_SEARCH_FTS_INSERT_SQL = `
  INSERT INTO building_search_fts (osm_key, name, address, style, architect)
  VALUES (?, ?, ?, ?, ?)
`;

const BUILDING_SEARCH_FTS_DELETE_SQL = `
  DELETE FROM building_search_fts
  WHERE osm_key = ?
`;

function buildRawSearchSourceQuery(options: LooseRecord = {}) {
  const where = String(options.where || '').trim();
  const orderBy = String(options.orderBy || 'ORDER BY bc.osm_type ASC, bc.osm_id ASC').trim();
  const limitClause = String(options.limitClause || '').trim();
  return `
    SELECT
      ${SEARCH_SOURCE_RAW_SELECT_FIELDS}
    ${SEARCH_SOURCE_BASE_FROM_SQL}
    ${where ? `${where}\n` : ''}${orderBy}
    ${limitClause ? `\n${limitClause}` : ''}
  `;
}

function normalizeNullableSearchText(value) {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function parseTagsJson(raw) {
  if (raw == null) return {};
  const text = String(raw).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function pickFirstText(...values) {
  for (const value of values) {
    const normalized = normalizeNullableSearchText(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function dedupeTextParts(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = normalizeNullableSearchText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function buildAddressFromTags(tags = {}) {
  const fullAddress = normalizeNullableSearchText(tags['addr:full']);
  if (fullAddress) {
    return fullAddress;
  }
  const parts = dedupeTextParts([
    tags['addr:postcode'],
    tags['addr:city'],
    tags['addr:place'],
    tags['addr:street'],
    tags['addr:housenumber']
  ]);
  return parts.length > 0 ? parts.join(', ') : null;
}

function hasSearchSourceValues(sourceRow) {
  return Boolean(
    normalizeNullableSearchText(sourceRow?.name)
    || normalizeNullableSearchText(sourceRow?.address)
    || normalizeNullableSearchText(sourceRow?.style)
    || normalizeNullableSearchText(sourceRow?.architect)
  );
}

function normalizeSearchSourceRow(rawRow) {
  if (!rawRow) return null;
  const osmType = normalizeNullableSearchText(rawRow.osm_type);
  const osmId = Number(rawRow.osm_id);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) {
    return null;
  }

  const tags = parseTagsJson(rawRow.tags_json);
  if (getFeatureKindFromTagsJson(rawRow.tags_json) === 'building_part') {
    return null;
  }
  const name = pickFirstText(
    rawRow.local_name,
    tags.name,
    tags['name:ru'],
    tags.official_name
  );
  const address = pickFirstText(
    rawRow.local_address,
    buildAddressFromTags(tags)
  );
  const style = pickFirstText(
    rawRow.local_style,
    tags['building:architecture'],
    tags.architecture,
    tags.style
  );
  const architect = pickFirstText(
    rawRow.local_architect,
    tags.architect,
    tags.architect_name
  );
  const centerLon = Number(rawRow.center_lon);
  const centerLat = Number(rawRow.center_lat);

  const normalized = {
    osm_key: `${osmType}/${osmId}`,
    osm_type: osmType,
    osm_id: osmId,
    name,
    address,
    style,
    architect,
    local_priority: Number(rawRow.local_priority || 0) > 0 ? 1 : 0,
    center_lon: Number.isFinite(centerLon) ? centerLon : 0,
    center_lat: Number.isFinite(centerLat) ? centerLat : 0
  };
  return hasSearchSourceValues(normalized) ? normalized : null;
}

function normalizeSearchSourceRows(rows = []) {
  return rows
    .map(normalizeSearchSourceRow)
    .filter(Boolean);
}

module.exports = {
  BUILDING_SEARCH_FTS_DELETE_SQL,
  BUILDING_SEARCH_FTS_INSERT_SQL,
  BUILDING_SEARCH_SOURCE_DELETE_SQL,
  BUILDING_SEARCH_SOURCE_INSERT_SQL,
  BUILDING_SEARCH_SOURCE_UPSERT_SQL,
  SEARCH_SOURCE_RAW_SELECT_FIELDS,
  SEARCH_SOURCE_BASE_FROM_SQL,
  buildRawSearchSourceQuery,
  hasSearchSourceValues,
  normalizeNullableSearchText,
  normalizeSearchSourceRow,
  normalizeSearchSourceRows
};
