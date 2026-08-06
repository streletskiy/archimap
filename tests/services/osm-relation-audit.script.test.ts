const assert = require('node:assert/strict');
const test = require('node:test');

const {
  auditChangesetRelations,
  extractModifiedRelations,
  parseCliArgs
} = require('../../scripts/audit-osm-relation-members');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body
  };
}

test('extractModifiedRelations ignores ways and keeps ordered relation members', () => {
  const relations = extractModifiedRelations(`
    <osmChange version="0.6">
      <modify>
        <way id="10" version="2"><nd ref="1"/><nd ref="2"/></way>
        <relation id="20" version="3">
          <member type="way" ref="30" role="outer"/>
          <member type="way" ref="31" role="inner"/>
          <tag k="type" v="multipolygon"/>
        </relation>
      </modify>
    </osmChange>
  `);

  assert.equal(relations.length, 1);
  assert.deepEqual(relations[0], {
    id: 20,
    version: 3,
    members: [
      { type: 'way', ref: '30', role: 'outer' },
      { type: 'way', ref: '31', role: 'inner' }
    ]
  });
});

test('auditChangesetRelations reports a destructive member removal', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/changeset/180986671/download')) {
      return response(`
        <osmChange version="0.6">
          <modify>
            <relation id="2828359" version="2">
              <tag k="type" v="multipolygon"/>
            </relation>
          </modify>
        </osmChange>
      `);
    }
    if (url.endsWith('/relation/2828359/1')) {
      return response(`
        <osm>
          <relation id="2828359" version="1">
            <member type="way" ref="80664991" role="outer"/>
            <member type="way" ref="158628627" role="outer"/>
            <tag k="type" v="multipolygon"/>
          </relation>
        </osm>
      `);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const [result] = await auditChangesetRelations(180986671, { fetchImpl });

  assert.equal(result.structureChanged, true);
  assert.equal(result.beforeMemberCount, 2);
  assert.equal(result.afterMemberCount, 0);
  assert.deepEqual(result.membersRemoved, [
    { type: 'way', ref: '80664991', role: 'outer' },
    { type: 'way', ref: '158628627', role: 'outer' }
  ]);
});

test('parseCliArgs accepts comma-separated ids and removes duplicates', () => {
  assert.deepEqual(parseCliArgs(['180986671,180986702', '180986671', '--json']), {
    ids: [180986671, 180986702],
    json: true
  });
});
