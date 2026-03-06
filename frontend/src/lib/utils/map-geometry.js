function walkGeometryCoordinates(coordinates, visit) {
  if (!Array.isArray(coordinates)) return;
  if (coordinates.length >= 2 && typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    visit(coordinates[0], coordinates[1]);
    return;
  }
  for (const item of coordinates) {
    walkGeometryCoordinates(item, visit);
  }
}

export function getGeometryCenter(geometry) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  walkGeometryCoordinates(geometry?.coordinates, (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

export function getGeometryBounds(maplibregl, geometry) {
  if (!maplibregl?.LngLatBounds) return null;
  const bounds = new maplibregl.LngLatBounds();
  let hasPoint = false;

  walkGeometryCoordinates(geometry?.coordinates, (x, y) => {
    bounds.extend([x, y]);
    hasPoint = true;
  });

  return hasPoint ? bounds : null;
}

export function focusMapOnGeometry(map, maplibregl, geometry, options = {}) {
  if (!map || !geometry) return;
  const bounds = getGeometryBounds(maplibregl, geometry);
  if (!bounds || bounds.isEmpty()) return;

  const {
    duration = 450,
    pointZoom = 15,
    padding = 80,
    maxZoom = 15
  } = options;

  const southWest = bounds.getSouthWest();
  const northEast = bounds.getNorthEast();
  const isPoint = Math.abs(southWest.lng - northEast.lng) < 1e-8
    && Math.abs(southWest.lat - northEast.lat) < 1e-8;

  if (isPoint) {
    map.easeTo({ center: [southWest.lng, southWest.lat], zoom: pointZoom, duration });
    return;
  }

  map.fitBounds(bounds, { padding, duration, maxZoom });
}
