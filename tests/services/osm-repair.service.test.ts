const test = require('node:test');
const assert = require('node:assert/strict');

const { createOsmRepairService, geometryFingerprint } = require('../../src/lib/server/services/osm-repair.service');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => String(body || '')
  };
}

function osmElement(type, attrs, children = '') {
  return `<osm version="0.6"><${type} ${attrs}>${children}</${type}></osm>`;
}

function installFetchMock(handler) {
  const previous = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = previous;
  };
}

test('repairDamagedRelations restores relation members and migrates an exact replacement geometry', async () => {
  const requests = [];
  const currentRelations = {
    101: osmElement('relation', 'id="101" version="2" visible="true"', '<tag k="building" v="yes"/>'),
    202: osmElement(
      'relation',
      'id="202" version="4" visible="true"',
      '<tag k="building" v="apartments"/><tag k="design" v="typical"/><tag k="design:ref" v="A-1"/>'
    )
  };
  const historicalRelations = {
    '101/1': osmElement(
      'relation',
      'id="101" version="1" visible="true"',
      '<member type="way" ref="301" role="outer"/><member type="way" ref="302" role="outer"/><tag k="building" v="yes"/>'
    ),
    '202/3': osmElement(
      'relation',
      'id="202" version="3" visible="true"',
      '<member type="way" ref="401" role="outer"/><member type="way" ref="402" role="outer"/><tag k="building" v="apartments"/>'
    )
  };
  const currentWays = {
    301: osmElement('way', 'id="301" version="5" visible="true"', '<nd ref="1"/><nd ref="2"/>'),
    302: osmElement('way', 'id="302" version="6" visible="true"', '<nd ref="2"/><nd ref="1"/>'),
    500: osmElement(
      'way',
      'id="500" version="7" visible="true"',
      '<nd ref="10"/><nd ref="13"/><nd ref="12"/><nd ref="11"/><nd ref="10"/><tag k="building" v="apartments"/>'
    )
  };
  const historicalWays = {
    '401/8': osmElement(
      'way',
      'id="401" version="8" visible="true"',
      '<nd ref="10"/><nd ref="11"/><nd ref="12"/><nd ref="13"/>'
    ),
    '402/9': osmElement('way', 'id="402" version="9" visible="true"', '<nd ref="13"/><nd ref="10"/>')
  };

  const restoreFetch = installFetchMock(async (input, init: any = {}) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, method: init.method || 'GET', body: String(init.body || '') });
    const relationVersion = url.pathname.match(/^\/api\/0\.6\/relation\/(\d+)\/(\d+)$/);
    if (relationVersion) return response(historicalRelations[`${relationVersion[1]}/${relationVersion[2]}`]);
    const relation = url.pathname.match(/^\/api\/0\.6\/relation\/(\d+)$/);
    if (relation && (!init.method || init.method === 'GET')) return response(currentRelations[Number(relation[1])]);
    const wayVersion = url.pathname.match(/^\/api\/0\.6\/way\/(\d+)\/(\d+)$/);
    if (wayVersion) return response(historicalWays[`${wayVersion[1]}/${wayVersion[2]}`]);
    const way = url.pathname.match(/^\/api\/0\.6\/way\/(\d+)$/);
    if (way && (!init.method || init.method === 'GET')) return response(currentWays[Number(way[1])]);
    if (url.pathname === '/api/0.6/changeset/create' && init.method === 'PUT') return response('9001');
    if (url.pathname === '/api/0.6/relation/101' && init.method === 'PUT') return response('3');
    if (url.pathname === '/api/0.6/way/500' && init.method === 'PUT') return response('8');
    if (url.pathname === '/api/0.6/relation/202' && init.method === 'DELETE') return response('5');
    if (url.pathname === '/api/0.6/changeset/9001/close' && init.method === 'PUT') return response('');
    throw new Error(`Unexpected request: ${init.method || 'GET'} ${url.pathname}`);
  });

  const service = createOsmRepairService({
    getCredentials: async () => ({ accessToken: 'token', apiBaseUrl: 'https://api.openstreetmap.test' })
  });
  const result = await service.repairDamagedRelations({
    items: [
      {
        action: 'restore_members',
        relationId: 101,
        expectedVersion: 2,
        sourceVersion: 1
      },
      {
        action: 'migrate_relation_to_way',
        relationId: 202,
        expectedVersion: 4,
        sourceVersion: 3,
        wayId: 500,
        expectedWayVersion: 7,
        tagKeys: ['design', 'design:ref'],
        memberVersions: [
          { type: 'way', ref: 401, version: 8 },
          { type: 'way', ref: 402, version: 9 }
        ]
      }
    ]
  });
  restoreFetch();

  assert.equal(result.changesetId, 9001);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], {
    action: 'restore_members',
    relationId: 101,
    memberCount: 2,
    version: 3
  });
  assert.equal(result.items[1].relationDeleted, true);
  assert.equal(result.items[1].wayVersion, 8);

  const relationPut = requests.find((item) => item.path === '/api/0.6/relation/101' && item.method === 'PUT');
  assert.ok(relationPut);
  assert.match(relationPut.body, /<member type="way" ref="301" role="outer"\/>/);
  assert.match(relationPut.body, /<member type="way" ref="302" role="outer"\/>/);
  assert.match(relationPut.body, /changeset="9001"/);

  const wayPut = requests.find((item) => item.path === '/api/0.6/way/500' && item.method === 'PUT');
  assert.ok(wayPut);
  assert.match(wayPut.body, /<tag k="design" v="typical"\/>/);
  assert.match(wayPut.body, /<tag k="design:ref" v="A-1"\/>/);
  assert.match(wayPut.body, /<nd ref="10"\/>\s*<nd ref="13"\/>\s*<nd ref="12"\/>\s*<nd ref="11"\/>/);

  const relationDelete = requests.find(
    (item) => item.path === '/api/0.6/relation/202' && item.method === 'DELETE'
  );
  assert.ok(relationDelete);
  assert.match(relationDelete.body, /<relation id="202" version="4" visible="true" changeset="9001">/);
});

test('repairDamagedRelations refuses a replacement way with different edges before opening a changeset', async () => {
  let changesetCreated = false;
  const restoreFetch = installFetchMock(async (input, init: any = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/0.6/relation/202') {
      return response(
        osmElement(
          'relation',
          'id="202" version="4" visible="true"',
          '<tag k="building" v="apartments"/><tag k="design" v="typical"/>'
        )
      );
    }
    if (url.pathname === '/api/0.6/relation/202/3') {
      return response(
        osmElement(
          'relation',
          'id="202" version="3" visible="true"',
          '<member type="way" ref="401" role="outer"/><tag k="building" v="apartments"/>'
        )
      );
    }
    if (url.pathname === '/api/0.6/way/500') {
      return response(
        osmElement(
          'way',
          'id="500" version="7" visible="true"',
          '<nd ref="10"/><nd ref="11"/><nd ref="99"/><nd ref="10"/><tag k="building" v="apartments"/>'
        )
      );
    }
    if (url.pathname === '/api/0.6/way/401/8') {
      return response(
        osmElement(
          'way',
          'id="401" version="8" visible="true"',
          '<nd ref="10"/><nd ref="11"/><nd ref="12"/><nd ref="10"/>'
        )
      );
    }
    if (url.pathname === '/api/0.6/changeset/create' && init.method === 'PUT') {
      changesetCreated = true;
      return response('9002');
    }
    throw new Error(`Unexpected request: ${init.method || 'GET'} ${url.pathname}`);
  });

  const service = createOsmRepairService({
    getCredentials: async () => ({ accessToken: 'token', apiBaseUrl: 'https://api.openstreetmap.test' })
  });
  await assert.rejects(
    () =>
      service.repairDamagedRelations({
        items: [
          {
            action: 'migrate_relation_to_way',
            relationId: 202,
            expectedVersion: 4,
            sourceVersion: 3,
            wayId: 500,
            expectedWayVersion: 7,
            tagKeys: ['design'],
            memberVersions: [{ type: 'way', ref: 401, version: 8 }]
          }
        ]
      }),
    (error) => {
      assert.equal(error.code, 'OSM_REPAIR_GEOMETRY_MISMATCH');
      assert.equal(error.status, 409);
      return true;
    }
  );
  restoreFetch();
  assert.equal(changesetCreated, false);
});

test('repairDamagedRelations dry-run performs the live preflight without opening a changeset', async () => {
  let changesetCreated = false;
  const restoreFetch = installFetchMock(async (input, init: any = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/0.6/relation/101') {
      return response(osmElement('relation', 'id="101" version="2" visible="true"', '<tag k="building" v="yes"/>'));
    }
    if (url.pathname === '/api/0.6/relation/101/1') {
      return response(
        osmElement(
          'relation',
          'id="101" version="1" visible="true"',
          '<member type="way" ref="301" role="outer"/><member type="way" ref="302" role="outer"/>'
        )
      );
    }
    if (url.pathname === '/api/0.6/way/301') {
      return response(osmElement('way', 'id="301" version="5" visible="true"', '<nd ref="1"/><nd ref="2"/>'));
    }
    if (url.pathname === '/api/0.6/way/302') {
      return response(osmElement('way', 'id="302" version="6" visible="true"', '<nd ref="2"/><nd ref="1"/>'));
    }
    if (url.pathname === '/api/0.6/changeset/create' && init.method === 'PUT') {
      changesetCreated = true;
      return response('9003');
    }
    throw new Error(`Unexpected request: ${init.method || 'GET'} ${url.pathname}`);
  });

  const service = createOsmRepairService({
    getCredentials: async () => ({ accessToken: 'token', apiBaseUrl: 'https://api.openstreetmap.test' })
  });
  const result = await service.repairDamagedRelations({
    dryRun: true,
    items: [
      {
        action: 'restore_members',
        relationId: 101,
        expectedVersion: 2,
        sourceVersion: 1
      }
    ]
  });
  restoreFetch();

  assert.equal(result.dryRun, true);
  assert.equal(result.changesetId, null);
  assert.equal(result.items[0].memberCount, 2);
  assert.equal(changesetCreated, false);
});

test('geometryFingerprint ignores way direction but preserves edge multiplicity', () => {
  assert.equal(
    geometryFingerprint([{ type: 'way', nodeRefs: ['1', '2', '3', '1'] }]),
    geometryFingerprint([{ type: 'way', nodeRefs: ['1', '3', '2', '1'] }])
  );
  assert.notEqual(
    geometryFingerprint([{ type: 'way', nodeRefs: ['1', '2', '3', '1'] }]),
    geometryFingerprint([{ type: 'way', nodeRefs: ['1', '2', '1'] }])
  );
});
