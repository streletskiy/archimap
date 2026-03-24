const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadBuildingMapper() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'utils', 'building-mapper.ts');
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

test('buildBulkBuildingFormState preserves shared values and marks mixed fields', async () => {
  const { buildBulkBuildingFormState } = await loadBuildingMapper();
  const detailsList = [
    {
      region_slugs: ['moscow'],
      properties: {
        archiInfo: {
          name: 'Alpha House',
          style: 'modern',
          material: 'brick',
          colour: '#aa5500',
          levels: 4,
          year_built: 1988,
          architect: 'Alice',
          archimap_description: 'Corner plot',
          _sourceTags: {}
        }
      }
    },
    {
      region_slugs: ['moscow', 'center'],
      properties: {
        archiInfo: {
          name: 'Beta Hall',
          style: 'modern',
          material: 'glass',
          colour: '#aa5500',
          levels: 4,
          year_built: 1990,
          architect: 'Alice',
          archimap_description: '',
          _sourceTags: {}
        }
      }
    }
  ];

  const state = buildBulkBuildingFormState(detailsList);

  assert.equal(state.form.style, 'modern');
  assert.equal(state.form.levels, '4');
  assert.equal(state.form.architect, 'Alice');
  assert.equal(state.form.name, '');
  assert.equal(state.form.material, '');
  assert.equal(state.form.yearBuilt, '');
  assert.equal(state.form.archimapDescription, '');
  assert.equal(state.fieldState.name.isMixed, true);
  assert.deepEqual(state.fieldState.name.sampleValues, ['Alpha House', 'Beta Hall']);
  assert.equal(state.fieldState.style.isMixed, false);
  assert.deepEqual(state.fieldState.style.sampleValues, ['modern']);
  assert.equal(state.fieldState.material.isMixed, true);
  assert.deepEqual(state.regionSlugs, ['moscow', 'center']);
});

