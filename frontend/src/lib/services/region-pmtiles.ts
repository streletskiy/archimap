export function buildRegionSourceId(regionId) {
  return `region-buildings-${Number(regionId)}`;
}

export function buildRegionLayerId(regionId, suffix) {
  return `${buildRegionSourceId(regionId)}-${String(suffix || '').trim()}`;
}

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
