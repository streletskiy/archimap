const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compilePostgresFilterRulePredicate,
  compilePostgresFilterRulesPredicate,
  compilePostgresFilterRuleGuardPredicate,
  compilePostgresFilterRulesGuardPredicate
} = require('../../src/lib/server/http/buildings.route');

test('compilePostgresFilterRulePredicate: compiles supported operators with stable params', () => {
  const contains = compilePostgresFilterRulePredicate({
    key: 'name',
    op: 'contains',
    valueNormalized: 'alpha'
  });
  assert.match(contains.sql, /strpos\(lower\(CASE WHEN jsonb_exists\(src\.tags_jsonb, \?\) THEN jsonb_extract_path_text\(src\.tags_jsonb, \?\) ELSE src\.name END\), \?\) > 0/);
  assert.deepEqual(contains.params, ['name', 'name', 'alpha']);

  const equals = compilePostgresFilterRulePredicate({
    key: 'archi.style',
    op: 'equals',
    valueNormalized: 'neo'
  });
  assert.match(equals.sql, /lower\(CASE WHEN jsonb_exists\(src\.tags_jsonb, \?\) THEN jsonb_extract_path_text\(src\.tags_jsonb, \?\) ELSE src\.style END\) = \?/);
  assert.deepEqual(equals.params, ['archi.style', 'archi.style', 'neo']);

  const notEquals = compilePostgresFilterRulePredicate({
    key: 'foo',
    op: 'not_equals',
    valueNormalized: 'bar'
  });
  assert.match(notEquals.sql, /lower\(CASE WHEN jsonb_exists\(src\.tags_jsonb, \?\) THEN jsonb_extract_path_text\(src\.tags_jsonb, \?\) ELSE NULL::text END\) <> \?/);
  assert.deepEqual(notEquals.params, ['foo', 'foo', 'bar']);

  const startsWith = compilePostgresFilterRulePredicate({
    key: 'prefix',
    op: 'starts_with',
    valueNormalized: 'sam'
  });
  assert.match(startsWith.sql, /lower\(CASE WHEN jsonb_exists\(src\.tags_jsonb, \?\) THEN jsonb_extract_path_text\(src\.tags_jsonb, \?\) ELSE NULL::text END\) LIKE \(\? \|\| '%'\)/);
  assert.deepEqual(startsWith.params, ['prefix', 'prefix', 'sam']);

  const exists = compilePostgresFilterRulePredicate({
    key: 'style',
    op: 'exists',
    valueNormalized: ''
  });
  assert.match(exists.sql, /COALESCE\(length\(btrim\(CASE WHEN jsonb_exists\(src\.tags_jsonb, \?\) THEN jsonb_extract_path_text\(src\.tags_jsonb, \?\) ELSE src\.style END\)\), 0\) > 0/);
  assert.deepEqual(exists.params, ['style', 'style']);

  const notExists = compilePostgresFilterRulePredicate({
    key: 'name',
    op: 'not_exists',
    valueNormalized: ''
  });
  assert.match(notExists.sql, /COALESCE\(length\(btrim\(CASE WHEN jsonb_exists\(src\.tags_jsonb, \?\) THEN jsonb_extract_path_text\(src\.tags_jsonb, \?\) ELSE src\.name END\)\), 0\) = 0/);
  assert.deepEqual(notExists.params, ['name', 'name']);
});

test('compilePostgresFilterRulesPredicate: combines predicates and preserves params order', () => {
  const compiled = compilePostgresFilterRulesPredicate([
    { key: 'name', op: 'contains', valueNormalized: 'alpha' },
    { key: 'foo', op: 'not_equals', valueNormalized: 'bar' },
    { key: 'style', op: 'exists', valueNormalized: '' }
  ]);

  assert.match(compiled.sql, /^\(.+\) AND \(.+\) AND \(.+\)$/);
  assert.deepEqual(compiled.params, [
    'name', 'name', 'alpha',
    'foo', 'foo', 'bar',
    'style', 'style'
  ]);
});

test('compilePostgresFilterRulesPredicate: returns TRUE for empty rules and rejects unsupported op', () => {
  const empty = compilePostgresFilterRulesPredicate([]);
  assert.equal(empty.sql, 'TRUE');
  assert.deepEqual(empty.params, []);

  assert.throws(() => {
    compilePostgresFilterRulePredicate({
      key: 'name',
      op: 'regex',
      valueNormalized: '.*'
    });
  }, /Unsupported filter rule operator/);
});

test('compilePostgresFilterRuleGuardPredicate: keeps fallback semantics safe and stable', () => {
  const tagOnly = compilePostgresFilterRuleGuardPredicate({
    key: 'foo',
    op: 'not_equals',
    valueNormalized: 'bar'
  });
  assert.match(tagOnly.sql, /lower\(jsonb_extract_path_text\(base\.tags_jsonb, \?\)\) <> \?/);
  assert.deepEqual(tagOnly.params, ['foo', 'bar']);

  const fallbackEquals = compilePostgresFilterRuleGuardPredicate({
    key: 'name',
    op: 'equals',
    valueNormalized: 'alpha'
  });
  assert.match(fallbackEquals.sql, /NOT \(jsonb_exists\(base\.tags_jsonb, \?\) AND \(jsonb_extract_path_text\(base\.tags_jsonb, \?\) IS NULL OR lower\(jsonb_extract_path_text\(base\.tags_jsonb, \?\)\) <> \?\)\)/);
  assert.deepEqual(fallbackEquals.params, ['name', 'name', 'name', 'alpha']);

  const fallbackNotExists = compilePostgresFilterRuleGuardPredicate({
    key: 'archi.style',
    op: 'not_exists',
    valueNormalized: ''
  });
  assert.match(fallbackNotExists.sql, /NOT \(jsonb_exists\(base\.tags_jsonb, \?\) AND COALESCE\(length\(btrim\(jsonb_extract_path_text\(base\.tags_jsonb, \?\)\)\), 0\) > 0\)/);
  assert.deepEqual(fallbackNotExists.params, ['archi.style', 'archi.style']);
});

test('compilePostgresFilterRulesGuardPredicate: combines guard predicates and preserves params order', () => {
  const compiled = compilePostgresFilterRulesGuardPredicate([
    { key: 'name', op: 'contains', valueNormalized: 'alpha' },
    { key: 'foo', op: 'not_equals', valueNormalized: 'bar' },
    { key: 'style', op: 'exists', valueNormalized: '' }
  ]);

  assert.match(compiled.sql, /^\(.+\) AND \(.+\) AND \(.+\)$/);
  assert.deepEqual(compiled.params, [
    'name', 'name', 'name', 'alpha',
    'foo', 'bar',
    'style', 'style'
  ]);
});
