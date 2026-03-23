const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adminRegionsPath = path.resolve(__dirname, '..', '..', 'frontend', 'static', 'admin-regions.geojson');
const adminRegions = JSON.parse(fs.readFileSync(adminRegionsPath, 'utf8'));

const BERBERA_POINT = [45.0143, 10.4396];
const HARGEISA_POINT = [44.0581, 9.5624];
const JERUSALEM_POINT = [35.2137, 31.7683];
const GAZA_POINT = [34.4668, 31.5017];
const JERSEY_POINT = [-2.122384300684492, 49.21832916900004];
const GUERNSEY_POINT = [-2.5684653396292636, 49.47284577050007];
const CRIMEA_INTERIOR_POINT = [34.248991705571925, 45.299261786000045];
const SEVASTOPOL_INTERIOR_POINT = [33.64469276720039, 44.62659332900006];

function getFeatureByExtractId(extractId) {
  return adminRegions.features.find((feature) => feature?.properties?.ExtractId === extractId) || null;
}

function isPointOnSegment(point, start, end) {
  const [px, py] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const cross = (py - y1) * (x2 - x1) - (px - x1) * (y2 - y1);
  if (Math.abs(cross) > 1e-12) return false;

  const withinX = px >= Math.min(x1, x2) - 1e-12 && px <= Math.max(x1, x2) + 1e-12;
  const withinY = py >= Math.min(y1, y2) - 1e-12 && py <= Math.max(y1, y2) + 1e-12;
  return withinX && withinY;
}

function isPointInRing(point, ring) {
  let inside = false;
  const [x, y] = point;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const start = ring[i];
    const end = ring[j];
    if (isPointOnSegment(point, start, end)) return true;

    const [xi, yi] = start;
    const [xj, yj] = end;
    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);

    if (intersects) inside = !inside;
  }

  return inside;
}

function isPointInPolygon(point, polygonCoordinates) {
  if (!Array.isArray(polygonCoordinates) || polygonCoordinates.length === 0) return false;
  if (!isPointInRing(point, polygonCoordinates[0])) return false;

  for (const hole of polygonCoordinates.slice(1)) {
    if (isPointInRing(point, hole)) return false;
  }

  return true;
}

function geometryContainsPoint(geometry, point) {
  if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) return false;
  if (geometry.type === 'Polygon') return isPointInPolygon(point, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygonCoordinates) => isPointInPolygon(point, polygonCoordinates));
  }
  return false;
}

test('somalia admin region keeps Somaliland coverage from Natural Earth', () => {
  const feature = getFeatureByExtractId('somalia');

  assert.ok(feature, 'somalia feature should exist');
  assert.equal(feature.properties.ExtractSource, 'geofabrik');
  assert.equal(feature.properties.GeometrySource, 'natural-earth');
  assert.ok(geometryContainsPoint(feature.geometry, BERBERA_POINT), 'somalia contour should include Berbera');
  assert.ok(geometryContainsPoint(feature.geometry, HARGEISA_POINT), 'somalia contour should include Hargeisa');
});

test('israel-and-palestine admin region uses Natural Earth union coverage', () => {
  const feature = getFeatureByExtractId('israel-and-palestine');

  assert.ok(feature, 'israel-and-palestine feature should exist');
  assert.equal(feature.properties.ExtractSource, 'geofabrik');
  assert.equal(feature.properties.GeometrySource, 'natural-earth');
  assert.ok(geometryContainsPoint(feature.geometry, JERUSALEM_POINT), 'israel-and-palestine contour should include Jerusalem');
  assert.ok(geometryContainsPoint(feature.geometry, GAZA_POINT), 'israel-and-palestine contour should include Gaza');
});

test('guernsey-jersey admin region uses Natural Earth contours for both islands', () => {
  const feature = getFeatureByExtractId('guernsey-jersey');

  assert.ok(feature, 'guernsey-jersey feature should exist');
  assert.equal(feature.properties.ExtractSource, 'geofabrik');
  assert.equal(feature.properties.GeometrySource, 'natural-earth');
  assert.ok(geometryContainsPoint(feature.geometry, JERSEY_POINT), 'guernsey-jersey contour should include Jersey');
  assert.ok(geometryContainsPoint(feature.geometry, GUERNSEY_POINT), 'guernsey-jersey contour should include Guernsey');
});

test('crimean-fed-district admin region uses one combined Natural Earth Admin 1 contour', () => {
  const feature = getFeatureByExtractId('russia/crimean-fed-district');

  assert.ok(feature, 'crimean-fed-district feature should exist');
  assert.equal(feature.properties.ExtractSource, 'geofabrik');
  assert.equal(feature.properties.GeometrySource, 'natural-earth-admin1-union');
  assert.ok(geometryContainsPoint(feature.geometry, CRIMEA_INTERIOR_POINT), 'crimean-fed-district contour should include Crimea');
  assert.ok(geometryContainsPoint(feature.geometry, SEVASTOPOL_INTERIOR_POINT), 'crimean-fed-district contour should include Sevastopol');
  assert.equal(getFeatureByExtractId('russia/southern_federal_district/crimea_republic'), null);
  assert.equal(getFeatureByExtractId('russia/southern_federal_district/sevastopol'), null);
});
