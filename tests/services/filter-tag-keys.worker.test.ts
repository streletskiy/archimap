const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractFilterTagKeysFromTagsJson,
  scanPostgresFilterTagKeys
} = require('../../workers/rebuild-filter-tag-keys-cache.worker.ts');

test('extractFilterTagKeysFromTagsJson normalizes valid keys and skips invalid payloads', () => {
  assert.deepEqual(
    extractFilterTagKeysFromTagsJson(
      JSON.stringify({
        building: 'yes',
        'design:ref': '1-447',
        ' roof:shape ': 'flat'
      })
    ),
    ['building', 'design:ref', 'roof:shape']
  );
  assert.deepEqual(extractFilterTagKeysFromTagsJson('not json'), []);
  assert.deepEqual(extractFilterTagKeysFromTagsJson('[]'), []);
});

test('scanPostgresFilterTagKeys batches rows and deduplicates keys', async () => {
  const queries = [];
  const batches = [
    {
      rows: [
        { osm_type: 'relation', osm_id: 1, tags_json: JSON.stringify({ building: 'yes', name: 'A' }) },
        { osm_type: 'relation', osm_id: 2, tags_json: JSON.stringify({ 'design:ref': '1-2' }) }
      ]
    },
    {
      rows: [
        { osm_type: 'way', osm_id: 3, tags_json: JSON.stringify({ building: 'yes', architect: 'B' }) }
      ]
    },
    { rows: [] }
  ];

  const client = {
    async query(sql, params) {
      queries.push({
        sql: String(sql || '')
          .replace(/\s+/g, ' ')
          .trim(),
        params
      });
      return batches.shift() || { rows: [] };
    }
  };

  const keys = await scanPostgresFilterTagKeys(client, {
    batchSize: 2,
    ensureHealthy: () => {}
  });

  assert.deepEqual(keys, ['architect', 'building', 'design:ref', 'name']);
  assert.equal(queries.length, 3);
  assert.deepEqual(queries[0].params, ['', 0, 2]);
  assert.deepEqual(queries[1].params, ['relation', 2, 2]);
  assert.deepEqual(queries[2].params, ['way', 3, 2]);
});
