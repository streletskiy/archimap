const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadBuildingMapper() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'utils', 'building-mapper.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${importCounter += 1}`);
}

test('createEmptyBuildingForm and createEmptyBuildingComparable include design project fields', async () => {
  const { createEmptyBuildingForm, createEmptyBuildingComparable } = await loadBuildingMapper();

  assert.equal(createEmptyBuildingForm().colour, '');
  assert.equal(createEmptyBuildingForm().design, '');
  assert.equal(createEmptyBuildingForm().designRef, '');
  assert.equal(createEmptyBuildingForm().designYear, '');
  assert.equal(createEmptyBuildingForm().roofShape, '');
  assert.equal(createEmptyBuildingComparable().colour, '');
  assert.equal(createEmptyBuildingComparable().design, '');
  assert.equal(createEmptyBuildingComparable().designRef, '');
  assert.equal(createEmptyBuildingComparable().designYear, '');
  assert.equal(createEmptyBuildingComparable().roofShape, '');
});

test('hydrateBuildingForm uses design and colour fallbacks and normalizes the comparable snapshot', async () => {
  const { hydrateBuildingForm } = await loadBuildingMapper();
  const details = {
    properties: {
      archiInfo: {
        name: 'House',
        style: 'modern',
        design: 'typical',
        design_ref: null,
        design_year: null,
        roof_shape: null,
        colour: null,
        levels: 3,
        year_built: 1984,
        architect: 'A. Architect',
        address: 'Moscow',
        archimap_description: 'Demo',
        _sourceTags: {
          'building:colour': 'Sandstone',
          'design:ref': '1-335',
          'design:year': '1964',
          'roof:shape': 'gabled'
        }
      }
    }
  };

  const { form, initialComparable } = hydrateBuildingForm(details);

  assert.equal(form.colour, 'Sandstone');
  assert.equal(form.design, 'typical');
  assert.equal(form.designRef, '1-335');
  assert.equal(form.designYear, '1964');
  assert.equal(form.roofShape, 'gabled');
  assert.equal(initialComparable.colour, 'sandstone');
  assert.equal(initialComparable.design, 'typical');
  assert.equal(initialComparable.designRef, '1-335');
  assert.equal(initialComparable.designYear, '1964');
  assert.equal(initialComparable.roofShape, 'gabled');
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
          design: 'typical',
          design_ref: '1-335',
          design_year: '1964',
          material: 'brick',
          roof_shape: 'flat',
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
          design: 'typical',
          design_ref: '1-464',
          design_year: '1968',
          material: 'glass',
          roof_shape: 'flat',
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
  assert.equal(state.form.design, 'typical');
  assert.equal(state.form.levels, '4');
  assert.equal(state.form.architect, 'Alice');
  assert.equal(state.form.name, '');
  assert.equal(state.form.designRef, '');
  assert.equal(state.form.designYear, '');
  assert.equal(state.fieldState.design.isMixed, false);
  assert.deepEqual(state.fieldState.design.sampleValues, ['typical']);
  assert.equal(state.fieldState.designRef.isMixed, true);
  assert.deepEqual(state.fieldState.designRef.sampleValues, ['1-335', '1-464']);
  assert.equal(state.fieldState.designYear.isMixed, true);
  assert.deepEqual(state.fieldState.designYear.sampleValues, ['1964', '1968']);
  assert.equal(state.form.material, '');
  assert.equal(state.form.roofShape, 'flat');
  assert.equal(state.form.yearBuilt, '');
  assert.equal(state.form.archimapDescription, '');
  assert.equal(state.fieldState.name.isMixed, true);
  assert.deepEqual(state.fieldState.name.sampleValues, ['Alpha House', 'Beta Hall']);
  assert.equal(state.fieldState.style.isMixed, false);
  assert.deepEqual(state.fieldState.style.sampleValues, ['modern']);
  assert.equal(state.fieldState.material.isMixed, true);
  assert.deepEqual(state.regionSlugs, ['moscow', 'center']);
  assert.equal(state.fieldState.roofShape.isMixed, false);
  assert.deepEqual(state.fieldState.roofShape.sampleValues, ['flat']);
});

