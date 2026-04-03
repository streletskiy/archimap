const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadBuilding3dStack() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'building-3d-stack.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${(importCounter += 1)}`);
}

test('building-3d-stack exposes shared 3d height helpers', async () => {
  const { BUILDING_HIDE_BASE_WHEN_PARTS_PROPERTY, DEFAULT_MAP_3D_PITCH, getEffectiveBuildingPartsVisibility } =
    await loadBuilding3dStack();

  assert.equal(BUILDING_HIDE_BASE_WHEN_PARTS_PROPERTY, 'render_hide_base_when_parts');
  assert.equal(DEFAULT_MAP_3D_PITCH, 60);
  assert.equal(
    getEffectiveBuildingPartsVisibility({
      buildingPartsVisible: false,
      buildings3dEnabled: true
    }),
    true
  );
});

test('building-3d-stack exposes building layer filters and ids', async () => {
  const {
    BUILDING_FEATURE_KIND,
    OVERPASS_BUILDING_SOURCE_ID,
    buildRegionBuildingLayerFilterExpression,
    buildVisibleBuildingSelectionScopeExpression
  } = await loadBuilding3dStack();

  assert.equal(BUILDING_FEATURE_KIND, 'building');
  assert.equal(OVERPASS_BUILDING_SOURCE_ID, 'overpass-buildings-source');
  assert.deepEqual(
    buildVisibleBuildingSelectionScopeExpression({
      showBuildingParts: false
    }),
    ['==', ['coalesce', ['get', 'feature_kind'], 'building'], 'building']
  );
  assert.deepEqual(
    buildRegionBuildingLayerFilterExpression({
      featureKind: 'building_part'
    }),
    ['==', ['coalesce', ['get', 'feature_kind'], 'building'], 'building_part']
  );
});
