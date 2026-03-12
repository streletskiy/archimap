const test = require('node:test');
const assert = require('node:assert/strict');

const { compilePostgresFilterRulePredicate } = require('../../src/lib/server/http/buildings.route');

test('compilePostgresFilterRulePredicate parses decimal comma values for postgres numeric filters', () => {
  const compiled = compilePostgresFilterRulePredicate({
    key: 'building:levels',
    op: 'greater_than',
    value: '2,5'
  });

  assert.match(compiled.sql, /replace\(btrim\(CASE WHEN jsonb_exists\(src\.tags_jsonb, \?\) THEN jsonb_extract_path_text\(src\.tags_jsonb, \?\) ELSE NULL::text END\), ',', '\.'\)/);
  assert.match(compiled.sql, /> \?$/);
  assert.deepEqual(compiled.params, ['building:levels', 'building:levels', 'building:levels', 'building:levels', 2.5]);
});
