import { parseOsmKey } from './filter-utils.js';
import { SEARCH_RESULTS_CLUSTER_LAYER_ID } from './map-search-utils.js';
import type {
  FilterMapLike,
  FilterMatchedPoint
} from './filter-types.js';

export const FILTER_FALLBACK_MARKER_MAX_ZOOM = 13;

const FILTER_FALLBACK_SOURCE_PREFIX = 'filter-fallback-points';
const FILTER_FALLBACK_CLUSTER_RADIUS = 48;
const FILTER_FALLBACK_CLUSTER_MAX_ZOOM = 16;
const FILTER_FALLBACK_POINT_RADIUS_MIN = 4;
const FILTER_FALLBACK_POINT_RADIUS_MAX = 7;
const FILTER_FALLBACK_STROKE_COLOR = '#342700';

function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function normalizeColorToken(color: string) {
  const token = String(color || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return token || `color-${hashText(String(color || ''))}`;
}

function getPointJitter(pointId: number, color: string) {
  const token = `${normalizeColorToken(color)}:${Number(pointId)}`;
  const hash = Number.parseInt(hashText(token).slice(0, 8), 16) || 0;
  const angle = (hash % 360) * (Math.PI / 180);
  const distanceMeters = 5 + (hash % 7);
  return {
    x: Math.cos(angle) * distanceMeters,
    y: Math.sin(angle) * distanceMeters
  };
}

function normalizePoint(point: FilterMatchedPoint | null | undefined) {
  const id = Number(point?.id);
  const lon = Number(point?.lon);
  const lat = Number(point?.lat);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  const count = Number(point?.count);
  const normalizedCount = Number.isFinite(count) && count > 0 ? Math.max(1, Math.trunc(count)) : null;
  const osmKey = String(point?.osmKey || '').trim();
  return {
    id,
    lon,
    lat,
    ...(normalizedCount ? { count: normalizedCount } : {}),
    osmKey
  };
}

type FilterFallbackMarkerGroup = {
  color: string;
  points?: FilterMatchedPoint[] | null | undefined;
};

function normalizeMarkerGroups(groups: FilterFallbackMarkerGroup[] | null | undefined) {
  const normalized = [];
  const seenIds = new Set<number>();
  for (const group of Array.isArray(groups) ? groups : []) {
    const color = String(group?.color || '').trim();
    if (!color) continue;
    const points = [];
    for (const point of Array.isArray(group?.points) ? group.points : []) {
      const normalizedPoint = normalizePoint(point);
      if (!normalizedPoint || seenIds.has(normalizedPoint.id)) continue;
      seenIds.add(normalizedPoint.id);
      points.push(normalizedPoint);
    }
    if (points.length === 0) continue;
    normalized.push({
      color,
      points: points.sort((left, right) => left.id - right.id)
    });
  }
  return normalized;
}

export function getFilterFallbackSourceId(color: string) {
  return `${FILTER_FALLBACK_SOURCE_PREFIX}-${normalizeColorToken(color)}`;
}

export function getFilterFallbackClusterLayerId(color: string) {
  return `${getFilterFallbackSourceId(color)}-clusters`;
}

export function getFilterFallbackClusterCountLayerId(color: string) {
  return `${getFilterFallbackSourceId(color)}-counts`;
}

export function getFilterFallbackPointLayerId(color: string) {
  return `${getFilterFallbackSourceId(color)}-points`;
}

export function buildFilterFallbackMarkerGeojson(points: FilterMatchedPoint[] | null | undefined, color: string) {
  const features = [];
  for (const point of Array.isArray(points) ? points : []) {
    const normalizedPoint = normalizePoint(point);
    if (!normalizedPoint) continue;
    const jitter = getPointJitter(normalizedPoint.id, color);
    const metersPerDegreeLat = 111_320;
    const metersPerDegreeLon = 111_320 * Math.max(0.25, Math.cos(normalizedPoint.lat * Math.PI / 180));
    const jitterLon = normalizedPoint.lon + (jitter.x / metersPerDegreeLon);
    const jitterLat = normalizedPoint.lat + (jitter.y / metersPerDegreeLat);
    const parsed = normalizedPoint.osmKey ? parseOsmKey(normalizedPoint.osmKey) : null;
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [jitterLon, jitterLat]
      },
      properties: {
        filter_color: color,
        filter_feature_id: normalizedPoint.id,
        match_count: Math.max(1, Number(normalizedPoint.count || 1)),
        osm_key: normalizedPoint.osmKey || '',
        ...(parsed ? {
          osm_type: parsed.osmType,
          osm_id: parsed.osmId
        } : {})
      }
    });
  }
  return {
    type: 'FeatureCollection',
    features
  };
}

function removeFilterFallbackMarkerGroup(map: FilterMapLike | null | undefined, color: string) {
  if (!map) return;
  const sourceId = getFilterFallbackSourceId(color);
  const layerIds = [
    getFilterFallbackPointLayerId(color),
    getFilterFallbackClusterCountLayerId(color),
    getFilterFallbackClusterLayerId(color)
  ];
  for (const layerId of layerIds) {
    if (map.getLayer?.(layerId)) {
      map.removeLayer?.(layerId);
    }
  }
  if (map.getSource?.(sourceId)) {
    map.removeSource?.(sourceId);
  }
}

function ensureFilterFallbackMarkerGroup(
  map: FilterMapLike | null | undefined,
  group: { color: string; points: FilterMatchedPoint[] },
  beforeLayerId: string | null | undefined = SEARCH_RESULTS_CLUSTER_LAYER_ID
) {
  if (!map) return;
  const sourceId = getFilterFallbackSourceId(group.color);
  const clusterLayerId = getFilterFallbackClusterLayerId(group.color);
  const clusterCountLayerId = getFilterFallbackClusterCountLayerId(group.color);
  const pointLayerId = getFilterFallbackPointLayerId(group.color);
  const geojson = buildFilterFallbackMarkerGeojson(group.points, group.color);
  const beforeId = beforeLayerId && map.getLayer?.(beforeLayerId) ? beforeLayerId : undefined;

  if (!map.getSource?.(sourceId)) {
    map.addSource?.(sourceId, {
      type: 'geojson',
      data: geojson,
      cluster: true,
      clusterProperties: {
        match_count: ['+', ['get', 'match_count']]
      },
      clusterRadius: FILTER_FALLBACK_CLUSTER_RADIUS,
      clusterMaxZoom: FILTER_FALLBACK_CLUSTER_MAX_ZOOM
    });
  } else {
    map.getSource(sourceId)?.setData?.(geojson);
  }

  if (!map.getLayer?.(clusterLayerId)) {
    map.addLayer?.({
      id: clusterLayerId,
      type: 'circle',
      source: sourceId,
      filter: ['has', 'point_count'],
      paint: {
        'circle-radius': ['step', ['get', 'match_count'], 16, 12, 19, 30, 22, 60, 26],
        'circle-color': group.color,
        'circle-stroke-color': FILTER_FALLBACK_STROKE_COLOR,
        'circle-stroke-width': 2,
        'circle-opacity': 0.92
      }
    }, beforeId);
  }

  if (!map.getLayer?.(clusterCountLayerId)) {
    map.addLayer?.({
      id: clusterCountLayerId,
      type: 'symbol',
      source: sourceId,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['to-string', ['get', 'match_count']],
        'text-font': ['Open Sans Bold'],
        'text-size': 12
      },
      paint: {
        'text-color': FILTER_FALLBACK_STROKE_COLOR
      }
    }, beforeId);
  }

  if (!map.getLayer?.(pointLayerId)) {
    map.addLayer?.({
      id: pointLayerId,
      type: 'circle',
      source: sourceId,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'match_count'], 1, FILTER_FALLBACK_POINT_RADIUS_MIN, 5, FILTER_FALLBACK_POINT_RADIUS_MAX, 20, FILTER_FALLBACK_POINT_RADIUS_MAX],
        'circle-color': group.color,
        'circle-stroke-color': FILTER_FALLBACK_STROKE_COLOR,
        'circle-stroke-width': 2,
        'circle-opacity': 0.9
      }
    }, beforeId);
  }
}

export function applyFilterFallbackMarkerGroups({
  map,
  groups,
  previousGroups = [],
  beforeLayerId = SEARCH_RESULTS_CLUSTER_LAYER_ID
}: {
  map?: FilterMapLike | null | undefined;
  groups?: FilterFallbackMarkerGroup[] | null | undefined;
  previousGroups?: FilterFallbackMarkerGroup[] | null | undefined;
  beforeLayerId?: string | null | undefined;
} = {}) {
  const normalizedGroups = normalizeMarkerGroups(groups);
  const normalizedPreviousGroups = normalizeMarkerGroups(previousGroups);
  const previousColors = new Set(normalizedPreviousGroups.map((group) => group.color));
  const nextColors = new Set(normalizedGroups.map((group) => group.color));

  for (const group of normalizedPreviousGroups) {
    if (!nextColors.has(group.color)) {
      removeFilterFallbackMarkerGroup(map, group.color);
    }
  }

  for (const group of normalizedGroups) {
    ensureFilterFallbackMarkerGroup(map, group, beforeLayerId);
  }

  return {
    active: normalizedGroups.length > 0,
    groupCount: normalizedGroups.length,
    pointCount: normalizedGroups.reduce((sum, group) => sum + group.points.length, 0),
    previousCount: previousColors.size
  };
}
