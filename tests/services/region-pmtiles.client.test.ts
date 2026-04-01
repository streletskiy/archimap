const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadRegionPmtiles() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'region-pmtiles.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${importCounter += 1}`);
}

test('region building layers stay disabled until zoom 13', async () => {
  const {
    REGION_BUILDING_LAYER_MIN_ZOOM,
    shouldRenderRegionBuildings
  } = await loadRegionPmtiles();

  assert.equal(REGION_BUILDING_LAYER_MIN_ZOOM, 13);
  assert.equal(shouldRenderRegionBuildings(null), false);
  assert.equal(shouldRenderRegionBuildings(12.99), false);
  assert.equal(shouldRenderRegionBuildings(13), true);
  assert.equal(shouldRenderRegionBuildings(15), true);
});

test('viewport coverage helper works with intersecting region subsets', async () => {
  const {
    getActiveRegionPmtiles,
    isViewportCoveredByRegions
  } = await loadRegionPmtiles();

  const regions = [
    {
      id: 1,
      bounds: { west: 0, south: 0, east: 5, north: 10 }
    },
    {
      id: 2,
      bounds: { west: 5, south: 0, east: 10, north: 10 }
    },
    {
      id: 3,
      bounds: { west: 20, south: 20, east: 30, north: 30 }
    }
  ];
  const viewport = { west: 1, south: 1, east: 9, north: 9 };
  const activeRegions = getActiveRegionPmtiles(regions, viewport);

  assert.deepEqual(activeRegions.map((region) => region.id), [1, 2]);
  assert.equal(isViewportCoveredByRegions(activeRegions, viewport, { lng: 5, lat: 5 }), true);
  assert.equal(isViewportCoveredByRegions([regions[0]], viewport, { lng: 5, lat: 5 }), false);
});
