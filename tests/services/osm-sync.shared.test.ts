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
