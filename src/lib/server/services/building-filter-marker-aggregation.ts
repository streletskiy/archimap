const FILTER_MARKER_SERVER_AGGREGATE_MAX_ZOOM = 5;

function normalizeRenderMode(value) {
  return String(value || 'contours') === 'markers' ? 'markers' : 'contours';
}

function shouldAggregateMarkerMatches(renderMode, zoomBucket) {
  return normalizeRenderMode(renderMode) === 'markers' && Number(zoomBucket) < FILTER_MARKER_SERVER_AGGREGATE_MAX_ZOOM;
}

function getMarkerAggregationLegacyCellSize(zoomBucket) {
  const zoom = Number(zoomBucket);
  if (!Number.isFinite(zoom)) return 16;
  if (zoom < 10) return 12;
  if (zoom < 11) return 16;
  if (zoom < 12) return 20;
  return 24;
}

function getMarkerAggregationGridColumns(zoomBucket) {
  const zoom = Number(zoomBucket);
  if (!Number.isFinite(zoom)) return 40;
  if (zoom < 10.5) return 32;
  if (zoom < 11.5) return 40;
  if (zoom < 12.5) return 48;
  return 56;
}

function normalizeMarkerAggregationBbox(bbox) {
  const west = Number(bbox?.west ?? bbox?.minLon);
  const south = Number(bbox?.south ?? bbox?.minLat);
  const east = Number(bbox?.east ?? bbox?.maxLon);
  const north = Number(bbox?.north ?? bbox?.maxLat);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  const width = east - west;
  const height = north - south;
  if (!(width > 0) || !(height > 0)) return null;
  return {
    west,
    south,
    east,
    north,
    width,
    height
  };
}

function getMarkerAggregationGridShape(zoomBucket, bbox) {
  const columns = getMarkerAggregationGridColumns(zoomBucket);
  const normalizedBbox = normalizeMarkerAggregationBbox(bbox);
  if (!normalizedBbox) {
    return {
      bbox: null,
      columns,
      rows: columns
    };
  }
  const rows = Math.max(12, Math.round(columns * (normalizedBbox.height / normalizedBbox.width)));
  return {
    bbox: normalizedBbox,
    columns,
    rows
  };
}

function buildStableHash32(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildMarkerAggregationCellKey(zoomBucket, gridKey, cellX, cellY) {
  const zoomBucketId = Math.max(0, Math.trunc(Number(zoomBucket) * 2));
  return `cell:${zoomBucketId}:${gridKey}:${cellX}:${cellY}`;
}

function buildMarkerAggregationCellId(cellKey) {
  return (buildStableHash32(cellKey) || 0) + 1;
}

module.exports = {
  FILTER_MARKER_SERVER_AGGREGATE_MAX_ZOOM,
  buildMarkerAggregationCellId,
  buildMarkerAggregationCellKey,
  getMarkerAggregationGridColumns,
  getMarkerAggregationGridShape,
  getMarkerAggregationLegacyCellSize,
  normalizeMarkerAggregationBbox,
  normalizeRenderMode,
  shouldAggregateMarkerMatches
};
