export function buildRegionSourceId(regionId) {
  return `region-buildings-${Number(regionId)}`;
}

export function buildRegionLayerId(regionId, suffix) {
  return `${buildRegionSourceId(regionId)}-${String(suffix || '').trim()}`;
}

export const REGION_BUILDING_LAYER_MIN_ZOOM = 13;

export function boundsIntersect(left, right) {
  if (!left || !right) return false;
  return Number(left.west) < Number(right.east)
    && Number(left.east) > Number(right.west)
    && Number(left.south) < Number(right.north)
    && Number(left.north) > Number(right.south);
}

export function pointInBounds(lon, lat, bounds) {
  if (!bounds) return false;
  return Number(lon) >= Number(bounds.west)
    && Number(lon) <= Number(bounds.east)
    && Number(lat) >= Number(bounds.south)
    && Number(lat) <= Number(bounds.north);
}

export function normalizeBoundsLike(bounds) {
  if (!bounds) return null;
  if (typeof bounds.getWest === 'function') {
    return {
      west: Number(bounds.getWest()),
      south: Number(bounds.getSouth()),
      east: Number(bounds.getEast()),
      north: Number(bounds.getNorth())
    };
  }
  return {
    west: Number(bounds.west),
    south: Number(bounds.south),
    east: Number(bounds.east),
    north: Number(bounds.north)
  };
}

export function getActiveRegionPmtiles(regions, viewportBounds) {
  const viewport = normalizeBoundsLike(viewportBounds);
  if (!viewport) return [];
  return (Array.isArray(regions) ? regions : []).filter((region) => boundsIntersect(region?.bounds, viewport));
}

export function shouldRenderRegionBuildings(zoom) {
  const normalizedZoom = Number(zoom);
  return Number.isFinite(normalizedZoom) && normalizedZoom >= REGION_BUILDING_LAYER_MIN_ZOOM;
}

export function getViewportCoverageSamplePoints(viewportBounds, center = null) {
  const viewport = normalizeBoundsLike(viewportBounds);
  if (!viewport) return [];
  const west = Number(viewport.west);
  const east = Number(viewport.east);
  const south = Number(viewport.south);
  const north = Number(viewport.north);
  if (![west, east, south, north].every(Number.isFinite)) return [];

  const midLon = (west + east) / 2;
  const midLat = (north + south) / 2;
  const centerLon = Number(center?.lng);
  const centerLat = Number(center?.lat);
  const hasCenter = Number.isFinite(centerLon) && Number.isFinite(centerLat);

  return [
    [hasCenter ? centerLon : midLon, hasCenter ? centerLat : midLat],
    [west, north],
    [east, north],
    [east, south],
    [west, south],
    [midLon, north],
    [midLon, south],
    [west, midLat],
    [east, midLat]
  ];
}

export function isViewportCoveredByRegions(regions, viewportBounds, center = null) {
  const samplePoints = getViewportCoverageSamplePoints(viewportBounds, center);
  const normalizedRegions = Array.isArray(regions) ? regions : [];
  if (normalizedRegions.length === 0 || samplePoints.length === 0) return false;
  return samplePoints.every(([lon, lat]) => normalizedRegions.some((region) => pointInBounds(lon, lat, region?.bounds)));
}
