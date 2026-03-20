const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadBuildingMapper() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'utils', 'building-mapper.js');
  return import(`${pathToFileURL(modulePath).href}?v=${importCounter += 1}`);
}

test('createEmptyBuildingForm and createEmptyBuildingComparable include colour fields', async () => {
  const { createEmptyBuildingForm, createEmptyBuildingComparable } = await loadBuildingMapper();

  assert.equal(createEmptyBuildingForm().colour, '');
  assert.equal(createEmptyBuildingComparable().colour, '');
});

test('hydrateBuildingForm uses building:colour fallback and normalizes the comparable snapshot', async () => {
  const { hydrateBuildingForm } = await loadBuildingMapper();
  const details = {
    properties: {
      archiInfo: {
        name: 'House',
        style: 'modern',
        colour: null,
        levels: 3,
        year_built: 1984,
        architect: 'A. Architect',
        address: 'Moscow',
        archimap_description: 'Demo',
        _sourceTags: {
          'building:colour': 'Sandstone'
        }
      }
    }
  };

  const { form, initialComparable } = hydrateBuildingForm(details);

  assert.equal(form.colour, 'Sandstone');
  assert.equal(initialComparable.colour, 'sandstone');
});
