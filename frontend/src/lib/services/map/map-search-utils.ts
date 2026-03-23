export const SEARCH_RESULTS_SOURCE_ID = 'search-results-points';
export const SEARCH_RESULTS_LAYER_ID = 'search-results-points-layer';
export const SEARCH_RESULTS_CLUSTER_LAYER_ID = 'search-results-clusters-layer';
export const SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID = 'search-results-clusters-count-layer';
export const MAP_PIN_COLOR = '#FDC82F';
export const MAP_PIN_INK = '#342700';

export function getSearchItemPoint(item) {
  const lon = Number(item?.lon);
  const lat = Number(item?.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return [lon, lat];
}

export function buildSearchMarkersGeojson(items) {
  const features = [];
  for (const item of Array.isArray(items) ? items : []) {
    const point = getSearchItemPoint(item);
    if (!point) continue;
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: point
      },
      properties: {
        osm_type: String(item?.osmType || ''),
        osm_id: Number(item?.osmId || 0),
        osm_key: `${String(item?.osmType || '')}/${String(item?.osmId || '')}`
      }
    });
  }
  return {
    type: 'FeatureCollection',
    features
  };
}

export function updateSearchMarkers(map, items) {
  if (!map) return;
  const source = map.getSource(SEARCH_RESULTS_SOURCE_ID);
  if (!source) return;
  source.setData(buildSearchMarkersGeojson(items));
}

export function fitMapToSearchResults(map, items) {
  if (!map) return;
  const points = (Array.isArray(items) ? items : [])
    .map((item) => getSearchItemPoint(item))
    .filter(Boolean);
  if (points.length === 0) return;

  if (points.length === 1) {
    map.easeTo({
      center: points[0],
      zoom: Math.max(map.getZoom(), 16),
      duration: 450,
      essential: true
    });
    return;
  }

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }

  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
    padding: { top: 88, right: 30, bottom: 30, left: 30 },
    duration: 500,
    maxZoom: 16.5,
    essential: true
  });
}
