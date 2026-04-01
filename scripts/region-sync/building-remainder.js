/* global module, require */
const polygonClipping = require('polygon-clipping');
const {
  deriveFeatureKindFromTagsJson,
  normalizeFeatureKind
} = require('./common');

function cloneCoordinatePair(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const lon = Number(pair[0]);
  const lat = Number(pair[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

function closeLinearRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const normalized = [];
  for (const coordinate of ring) {
    const pair = cloneCoordinatePair(coordinate);
    if (!pair) continue;
    const previous = normalized[normalized.length - 1];
    if (previous && previous[0] === pair[0] && previous[1] === pair[1]) continue;
    normalized.push(pair);
  }
  if (normalized.length < 3) return null;
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    normalized.push([first[0], first[1]]);
  }
  return normalized.length >= 4 ? normalized : null;
}

function normalizePolygonCoordinates(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  const normalized = [];
  for (const ring of polygon) {
    const nextRing = closeLinearRing(ring);
    if (!nextRing) continue;
    normalized.push(nextRing);
  }
  return normalized.length > 0 ? normalized : null;
}

function normalizeMultiPolygonCoordinates(multiPolygon) {
  if (!Array.isArray(multiPolygon) || multiPolygon.length === 0) return null;
  const normalized = [];
  for (const polygon of multiPolygon) {
    const nextPolygon = normalizePolygonCoordinates(polygon);
    if (!nextPolygon) continue;
    normalized.push(nextPolygon);
  }
  return normalized.length > 0 ? normalized : null;
}

function parsePolygonGeometry(geometryJson) {
  const text = String(geometryJson || '').trim();
  if (!text) return null;
  let geometry;
  try {
    geometry = JSON.parse(text);
  } catch {
    return null;
  }
  const geometryType = String(geometry?.type || '').trim();
  if (geometryType === 'Polygon') {
    const coordinates = normalizePolygonCoordinates(geometry?.coordinates);
    return coordinates ? { type: 'Polygon', coordinates } : null;
  }
  if (geometryType === 'MultiPolygon') {
    const coordinates = normalizeMultiPolygonCoordinates(geometry?.coordinates);
    return coordinates ? { type: 'MultiPolygon', coordinates } : null;
  }
  return null;
}

function toPolygonClippingMultiPolygon(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') {
    return [geometry.coordinates];
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates;
  }
  return null;
}

function fromPolygonClippingMultiPolygon(multiPolygon) {
  const normalized = normalizeMultiPolygonCoordinates(multiPolygon);
  if (!normalized) return null;
  if (normalized.length === 1) {
    return {
      type: 'Polygon',
      coordinates: normalized[0]
    };
  }
  return {
    type: 'MultiPolygon',
    coordinates: normalized
  };
}

function collectGeometryBounds(coords, bounds = {
  minLon: Number.POSITIVE_INFINITY,
  minLat: Number.POSITIVE_INFINITY,
  maxLon: Number.NEGATIVE_INFINITY,
  maxLat: Number.NEGATIVE_INFINITY
}) {
  if (!Array.isArray(coords)) return bounds;
  if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      bounds.minLon = Math.min(bounds.minLon, lon);
      bounds.minLat = Math.min(bounds.minLat, lat);
      bounds.maxLon = Math.max(bounds.maxLon, lon);
      bounds.maxLat = Math.max(bounds.maxLat, lat);
    }
    return bounds;
  }
  for (const item of coords) {
    collectGeometryBounds(item, bounds);
  }
  return bounds;
}

function getGeometryBounds(geometry) {
  const bounds = collectGeometryBounds(geometry?.coordinates);
  if (
    !Number.isFinite(bounds.minLon)
    || !Number.isFinite(bounds.minLat)
    || !Number.isFinite(bounds.maxLon)
    || !Number.isFinite(bounds.maxLat)
  ) {
    return null;
  }
  return bounds;
}

function boundsContainBounds(container, inner) {
  if (!container || !inner) return false;
  return inner.minLon >= container.minLon
    && inner.maxLon <= container.maxLon
    && inner.minLat >= container.minLat
    && inner.maxLat <= container.maxLat;
}

function buildDifferenceGeometry(baseGeometry, subtractGeometries = []) {
  const subject = toPolygonClippingMultiPolygon(baseGeometry);
  const clipGeometries = subtractGeometries
    .map((geometry) => toPolygonClippingMultiPolygon(geometry))
    .filter(Boolean);
  if (!subject) {
    return { ok: false, geometry: null };
  }
  if (clipGeometries.length === 0) {
    return { ok: true, geometry: baseGeometry };
  }
  try {
    const clipMask = clipGeometries.length === 1
      ? clipGeometries[0]
      : polygonClipping.union(...clipGeometries);
    const difference = clipMask ? polygonClipping.difference(subject, clipMask) : subject;
    return {
      ok: true,
      geometry: fromPolygonClippingMultiPolygon(difference)
    };
  } catch {
    return { ok: false, geometry: null };
  }
}

function normalizeRowFeatureKind(row) {
  return normalizeFeatureKind(row?.feature_kind || deriveFeatureKindFromTagsJson(row?.tags_json));
}

function expandRowsWithBuildingRemainders(rows = []) {
  const normalizedRows = (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    feature_kind: normalizeRowFeatureKind(row),
    render_hide_base_when_parts: 0
  }));
  const buildings = [];
  const parts = [];

  for (const row of normalizedRows) {
    const geometry = parsePolygonGeometry(row?.geometry_json);
    const bounds = getGeometryBounds(geometry);
    if (!geometry || !bounds) continue;
    if (row.feature_kind === 'building_part') {
      parts.push({ row, geometry, bounds });
      continue;
    }
    if (row.feature_kind === 'building') {
      buildings.push({ row, geometry, bounds });
    }
  }

  const remainderRows = [];

  for (const building of buildings) {
    const containedParts = parts.filter((part) => boundsContainBounds(building.bounds, part.bounds));
    if (containedParts.length === 0) continue;
    const remainder = buildDifferenceGeometry(
      building.geometry,
      containedParts.map((part) => part.geometry)
    );
    if (!remainder.ok) continue;
    building.row.render_hide_base_when_parts = 1;
    const remainderBounds = getGeometryBounds(remainder.geometry);
    if (!remainder.geometry || !remainderBounds) continue;
    remainderRows.push({
      ...building.row,
      feature_kind: 'building_remainder',
      geometry_json: JSON.stringify(remainder.geometry),
      min_lon: remainderBounds.minLon,
      min_lat: remainderBounds.minLat,
      max_lon: remainderBounds.maxLon,
      max_lat: remainderBounds.maxLat,
      render_hide_base_when_parts: 0
    });
  }

  return [...remainderRows, ...normalizedRows];
}

module.exports = {
  expandRowsWithBuildingRemainders
};
