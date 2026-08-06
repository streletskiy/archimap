const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadModule() {
  const modulePath = path.join(process.cwd(), 'src', 'lib', 'server', 'services', 'osm-sync.shared.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${(importCounter += 1)}`);
}

async function loadChangesetBuilderModule() {
  const modulePath = path.join(process.cwd(), 'src', 'lib', 'server', 'services', 'osm-changeset-builder.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${(importCounter += 1)}`);
}

test('parseOsmElementResponse preserves ordered way nodes and relation members', async () => {
  const { parseOsmElementResponse } = await loadModule();

  const way = parseOsmElementResponse(`
    <osm>
      <way id="101" version="3" visible="true">
        <nd ref="11"/>
        <nd ref="12"/>
        <nd ref="11"/>
        <tag v="apartments" k="building"/>
      </way>
    </osm>
  `);
  const relation = parseOsmElementResponse(`
    <osm>
      <relation id="202" version="4" visible="true">
        <member role="outer" ref="301" type="way"/>
        <member type="way" ref="302" role="inner"/>
        <tag k="type" v="multipolygon"/>
      </relation>
    </osm>
  `);

  assert.deepEqual(way.nodeRefs, ['11', '12', '11']);
  assert.deepEqual(way.members, []);
  assert.equal(way.tags.building, 'apartments');
  assert.deepEqual(relation.nodeRefs, []);
  assert.deepEqual(relation.members, [
    { type: 'way', ref: '301', role: 'outer' },
    { type: 'way', ref: '302', role: 'inner' }
  ]);
});

test('buildElementXml preserves structural children and rejects missing structure', async () => {
  const { parseOsmElementResponse } = await loadModule();
  const { assertElementStructurePreserved, buildElementXml } = await loadChangesetBuilderModule();
  const source = parseOsmElementResponse(`
    <osm>
      <relation id="2828359" version="1" visible="true">
        <member type="way" ref="80664991" role="outer"/>
        <member type="way" ref="158628627" role="outer"/>
        <tag k="building" v="apartments"/>
        <tag k="type" v="multipolygon"/>
      </relation>
    </osm>
  `);

  const outbound = buildElementXml(source, {
    ...source.tags,
    'design:ref': '1-440-2'
  });

  assert.match(outbound, /<member type="way" ref="80664991" role="outer"\/>/);
  assert.match(outbound, /<member type="way" ref="158628627" role="outer"\/>/);
  assert.doesNotThrow(() => assertElementStructurePreserved(source, outbound));
  assert.throws(
    () =>
      assertElementStructurePreserved(
        source,
        outbound.replace('  <member type="way" ref="158628627" role="outer"/>\n', '')
      ),
    /structural children changed/
  );
  assert.throws(() => buildElementXml({ type: 'relation', attrs: source.attrs }, source.tags), /without its members/);
  assert.throws(
    () => buildElementXml({ type: 'way', attrs: source.attrs }, source.tags),
    /without its node references/
  );
});

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
