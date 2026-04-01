const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadModule() {
  const modulePath = path.join(process.cwd(), 'src', 'lib', 'server', 'services', 'osm-sync.shared.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${importCounter += 1}`);
}

test('buildDesiredTagMap writes building:levels and removes legacy levels', async () => {
  const { buildDesiredTagMap } = await loadModule();

  const { desired, removedKeys } = buildDesiredTagMap(
    {
      name: 'Tower',
      'building:levels': '2',
      levels: '2'
    },
    [
      {
        local_name: 'Tower',
        local_levels: 5,
        edited_fields_json: JSON.stringify(['levels'])
      }
    ]
  );

  assert.equal(desired.name, 'Tower');
  assert.equal(desired['building:levels'], '5');
  assert.equal(Object.prototype.hasOwnProperty.call(desired, 'levels'), false);
  assert.ok(removedKeys.includes('levels'));
});

test('buildDesiredTagMap writes roof:shape and removes legacy roof aliases', async () => {
  const { buildDesiredTagMap } = await loadModule();

  const { desired, removedKeys } = buildDesiredTagMap(
    {
      'roof:shape': 'flat',
      roof_shape: 'flat',
      'building:roof:shape': 'flat'
    },
    [
      {
        local_roof_shape: 'gabled',
        edited_fields_json: JSON.stringify(['roof_shape'])
      }
    ]
  );

  assert.equal(desired['roof:shape'], 'gabled');
  assert.equal(Object.prototype.hasOwnProperty.call(desired, 'roof_shape'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(desired, 'building:roof:shape'), false);
  assert.ok(removedKeys.includes('roof_shape'));
  assert.ok(removedKeys.includes('building:roof:shape'));
});

test('createPkceChallenge matches the RFC 7636 S256 example', async () => {
  const { createPkceChallenge } = await loadModule();

  const challenge = await createPkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');

  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
