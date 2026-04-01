const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadMap3dUtils() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'map-3d-utils.ts');
  return import(pathToFileURL(modulePath).href);
}

test('buildBuilding3dPropertiesFromTags derives top and base heights from levels and min-level tags', async () => {
  const { buildBuilding3dPropertiesFromTags } = await loadMap3dUtils();
  const properties = buildBuilding3dPropertiesFromTags({
    'building:levels': '4',
    min_level: '2',
    min_height: '5.5'
  });

  assert.deepEqual(properties, {
    render_height_m: 19.2,
    render_min_height_m: 6.4
  });
});

test('buildBuilding3dPropertiesFromTags falls back to a one-level extrusion', async () => {
  const { buildBuilding3dPropertiesFromTags } = await loadMap3dUtils();
  const properties = buildBuilding3dPropertiesFromTags({
    building: 'yes'
  });

  assert.deepEqual(properties, {
    render_height_m: 3.2,
    render_min_height_m: 0
  });
});

test('buildBuilding3dPropertiesFromTags uses explicit height when present', async () => {
  const { buildBuilding3dPropertiesFromTags } = await loadMap3dUtils();
  const properties = buildBuilding3dPropertiesFromTags({
    'building:levels': '4',
    'building:height': '18.5',
    min_height: '5.5'
  });

  assert.deepEqual(properties, {
    render_height_m: 18.5,
    render_min_height_m: 5.5
  });
});

test('buildBuilding3dPropertiesFromTags ignores explicit height below the base offset', async () => {
  const { buildBuilding3dPropertiesFromTags } = await loadMap3dUtils();
  const properties = buildBuilding3dPropertiesFromTags({
    height: '4',
    min_height: '5.5'
  });

  assert.deepEqual(properties, {
    render_height_m: 8.7,
    render_min_height_m: 5.5
  });
});

test('deriveBuildingLevelsText estimates levels from explicit height and base tags', async () => {
  const { deriveBuildingLevelsText } = await loadMap3dUtils();

  assert.equal(deriveBuildingLevelsText({
    tags: {
      height: '18.5',
      min_height: '5.5'
    }
  }), '4');
});

test('deriveBuildingLevelsText can infer levels from render heights without explicit level tags', async () => {
  const { deriveBuildingLevelsText } = await loadMap3dUtils();

  assert.equal(deriveBuildingLevelsText({
    tags: {},
    renderHeightMeters: 18.5,
    renderMinHeightMeters: 5.5
  }), '4');
  assert.equal(deriveBuildingLevelsText({
    tags: {},
    renderHeightMeters: 3.2,
    renderMinHeightMeters: 0
  }), null);
});

test('buildBuildingExtrusion expressions read the shared render properties', async () => {
  const {
    BUILDING_RENDER_HEIGHT_PROPERTY,
    BUILDING_RENDER_MIN_HEIGHT_PROPERTY,
    buildBuildingExtrusionBaseExpression,
    buildBuildingExtrusionHeightExpression
  } = await loadMap3dUtils();

  assert.deepEqual(buildBuildingExtrusionHeightExpression(), [
    'coalesce',
    ['to-number', ['get', BUILDING_RENDER_HEIGHT_PROPERTY]],
    0
  ]);
  assert.deepEqual(buildBuildingExtrusionBaseExpression(), [
    'coalesce',
    ['to-number', ['get', BUILDING_RENDER_MIN_HEIGHT_PROPERTY]],
    0
  ]);
});

test('getEffectiveBuildingPartsVisibility forces building parts on in 3D mode', async () => {
  const { getEffectiveBuildingPartsVisibility } = await loadMap3dUtils();

  assert.equal(getEffectiveBuildingPartsVisibility({
    buildingPartsVisible: false,
    buildings3dEnabled: false
  }), false);
  assert.equal(getEffectiveBuildingPartsVisibility({
    buildingPartsVisible: true,
    buildings3dEnabled: false
  }), true);
  assert.equal(getEffectiveBuildingPartsVisibility({
    buildingPartsVisible: false,
    buildings3dEnabled: true
  }), true);
});
