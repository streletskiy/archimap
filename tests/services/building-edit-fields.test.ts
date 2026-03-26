const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'utils', 'building-edit-fields.ts');
  return import(pathToFileURL(modulePath).href);
}

test('getBuildingEditableFields returns the full set for a single building', async () => {
  const { getBuildingEditableFields } = await loadModule();
  assert.deepEqual(getBuildingEditableFields(), [
    'name',
    'style',
    'design',
    'designRef',
    'designYear',
    'material',
    'colour',
    'levels',
    'yearBuilt',
    'architect',
    'address',
    'archimapDescription'
  ]);
});

test('getBuildingEditableFields removes address fields in bulk mode', async () => {
  const { getBuildingEditableFields } = await loadModule();
  assert.deepEqual(getBuildingEditableFields({ isBulkSelection: true }), [
    'style',
    'design',
    'designRef',
    'designYear',
    'material',
    'colour',
    'levels',
    'yearBuilt',
    'architect',
    'archimapDescription'
  ]);
});

test('getBuildingEditableFields narrows bulk edits to part-safe fields when needed', async () => {
  const { getBuildingEditableFields, filterBuildingEditedFields } = await loadModule();
  assert.deepEqual(getBuildingEditableFields({
    isBulkSelection: true,
    hasBuildingPartSelection: true
  }), [
    'levels',
    'colour',
    'style',
    'material',
    'yearBuilt'
  ]);

  assert.deepEqual(filterBuildingEditedFields(['name', 'style', 'design', 'designRef', 'designYear', 'address', 'colour'], {
    isBulkSelection: true,
    hasBuildingPartSelection: true
  }), [
    'style',
    'colour'
  ]);
});

test('filterBuildingEditedFields removes name in bulk mode', async () => {
  const { filterBuildingEditedFields } = await loadModule();
  assert.deepEqual(filterBuildingEditedFields(['name', 'style', 'architect'], {
    isBulkSelection: true
  }), [
    'style',
    'architect'
  ]);
});
