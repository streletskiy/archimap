const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'utils', 'roof-shape.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${(importCounter += 1)}`);
}

test('toHumanRoofShape returns localized labels when translation is available', async () => {
  const { ROOF_SHAPE_SELECT_OPTIONS, toHumanRoofShape, getRoofShapeOption } = await loadModule();

  assert.equal(
    toHumanRoofShape('gabled', (key) => (key === 'buildingModal.roofShapes.gabled' ? 'Двускатная' : key)),
    'Двускатная'
  );
  assert.equal(
    toHumanRoofShape('roof_shape_unknown', (key) => key),
    'Roof Shape Unknown'
  );
  assert.equal(getRoofShapeOption('flat')?.labelKey, 'buildingModal.roofShapes.flat');
  assert.equal(getRoofShapeOption('flat')?.imageUrl, '/images/roof-shapes/flat.png');
  assert.equal(
    ROOF_SHAPE_SELECT_OPTIONS.some((option) => option.value === 'gabled_height_moved'),
    false
  );
  assert.equal(
    ROOF_SHAPE_SELECT_OPTIONS.some((option) => option.value === 'many'),
    false
  );
  assert.equal(
    ROOF_SHAPE_SELECT_OPTIONS.some((option) => option.value === 'bellcast_gable'),
    false
  );
  assert.equal(getRoofShapeOption('gabled_height_moved')?.labelKey, 'buildingModal.roofShapes.gabled_height_moved');
  assert.equal(getRoofShapeOption('bellcast_gable')?.labelKey, 'buildingModal.roofShapes.bellcast_gable');
  assert.equal(getRoofShapeOption('many')?.labelKey, 'buildingModal.roofShapes.many');
});
