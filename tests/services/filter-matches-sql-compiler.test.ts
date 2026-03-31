const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFilterMatchBatchResults,
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
  assert.match(contains.sql, /strpos\(lower\(CASE WHEN COALESCE\(length\(btrim\(src\.name\)\), 0\) > 0 THEN src\.name ELSE jsonb_extract_path_text\(src\.tags_jsonb, \?\) END\), \?\) > 0/);
  assert.deepEqual(contains.params, ['name', 'alpha']);

  const equals = compilePostgresFilterRulePredicate({
    key: 'archi.style',
    op: 'equals',
    valueNormalized: 'neo'
  });
  assert.match(equals.sql, /lower\(CASE WHEN COALESCE\(length\(btrim\(src\.style\)\), 0\) > 0 THEN src\.style ELSE COALESCE\(jsonb_extract_path_text\(src\.tags_jsonb, \?\), jsonb_extract_path_text\(src\.tags_jsonb, \?\), jsonb_extract_path_text\(src\.tags_jsonb, \?\)\) END\) = \?/);
  assert.deepEqual(equals.params, ['building:architecture', 'architecture', 'style', 'neo']);

  const colour = compilePostgresFilterRulePredicate({
    key: 'colour',
    op: 'equals',
    valueNormalized: 'red'
  });
  assert.match(colour.sql, /lower\(CASE WHEN COALESCE\(length\(btrim\(src\.colour\)\), 0\) > 0 THEN src\.colour ELSE COALESCE\(jsonb_extract_path_text\(src\.tags_jsonb, \?\), jsonb_extract_path_text\(src\.tags_jsonb, \?\)\) END\) = \?/);
  assert.deepEqual(colour.params, ['building:colour', 'colour', 'red']);

  const notEquals = compilePostgresFilterRulePredicate({
    key: 'foo',
    op: 'not_equals',
    valueNormalized: 'bar'
  });
  assert.match(notEquals.sql, /lower\(CASE WHEN COALESCE\(length\(btrim\(jsonb_extract_path_text\(src\.tags_jsonb, \?\)\)\), 0\) > 0 THEN jsonb_extract_path_text\(src\.tags_jsonb, \?\) ELSE NULL::text END\) <> \?/);
  assert.deepEqual(notEquals.params, ['foo', 'foo', 'bar']);

  const startsWith = compilePostgresFilterRulePredicate({
    key: 'prefix',
    op: 'starts_with',
    valueNormalized: 'sam'
  });
  assert.match(startsWith.sql, /lower\(CASE WHEN COALESCE\(length\(btrim\(jsonb_extract_path_text\(src\.tags_jsonb, \?\)\)\), 0\) > 0 THEN jsonb_extract_path_text\(src\.tags_jsonb, \?\) ELSE NULL::text END\) LIKE \(\? \|\| '%'\)/);
  assert.deepEqual(startsWith.params, ['prefix', 'prefix', 'sam']);

  const exists = compilePostgresFilterRulePredicate({
    key: 'style',
    op: 'exists',
    valueNormalized: ''
  });
  assert.match(exists.sql, /COALESCE\(length\(btrim\(CASE WHEN COALESCE\(length\(btrim\(src\.style\)\), 0\) > 0 THEN src\.style ELSE COALESCE\(jsonb_extract_path_text\(src\.tags_jsonb, \?\), jsonb_extract_path_text\(src\.tags_jsonb, \?\), jsonb_extract_path_text\(src\.tags_jsonb, \?\)\) END\)\), 0\) > 0/);
  assert.deepEqual(exists.params, ['building:architecture', 'architecture', 'style']);

  const notExists = compilePostgresFilterRulePredicate({
    key: 'name',
    op: 'not_exists',
    valueNormalized: ''
  });
  assert.match(notExists.sql, /COALESCE\(length\(btrim\(CASE WHEN COALESCE\(length\(btrim\(src\.name\)\), 0\) > 0 THEN src\.name ELSE jsonb_extract_path_text\(src\.tags_jsonb, \?\) END\)\), 0\) = 0/);
  assert.deepEqual(notExists.params, ['name']);

  const greaterOrEquals = compilePostgresFilterRulePredicate({
    key: 'levels',
    op: 'greater_or_equals',
    value: '5',
    numericValue: 5
  });
  assert.match(greaterOrEquals.sql, /double precision ELSE NULL END >= \?/);
  assert.deepEqual(greaterOrEquals.params, ['levels', 'levels', 5]);

  const designRef = compilePostgresFilterRulePredicate({
    key: 'design:ref',
    op: 'equals',
    valueNormalized: '1-447с-43'
  });
  assert.match(designRef.sql, /lower\(CASE WHEN COALESCE\(length\(btrim\(src\.design_ref\)\), 0\) > 0 THEN src\.design_ref ELSE jsonb_extract_path_text\(src\.tags_jsonb, \?\) END\) = \?/);
  assert.deepEqual(designRef.params, ['design:ref', '1-447с-43']);
});

test('compilePostgresFilterRulesPredicate: combines predicates and preserves params order', () => {
  const compiled = compilePostgresFilterRulesPredicate([
    { key: 'name', op: 'contains', valueNormalized: 'alpha' },
    { key: 'foo', op: 'not_equals', valueNormalized: 'bar' },
    { key: 'style', op: 'exists', valueNormalized: '' }
  ]);

  assert.match(compiled.sql, /^\(.+\) AND \(.+\) AND \(.+\)$/);
  assert.deepEqual(compiled.params, [
    'name', 'alpha',
    'foo', 'foo', 'bar',
    'building:architecture', 'architecture', 'style'
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
  assert.equal(fallbackEquals.sql, 'TRUE');
  assert.deepEqual(fallbackEquals.params, []);

  const fallbackNotExists = compilePostgresFilterRuleGuardPredicate({
    key: 'archi.style',
    op: 'not_exists',
    valueNormalized: ''
  });
  assert.equal(fallbackNotExists.sql, 'TRUE');
  assert.deepEqual(fallbackNotExists.params, []);

  const fallbackGreaterOrEquals = compilePostgresFilterRuleGuardPredicate({
    key: 'archi.levels',
    op: 'greater_or_equals',
    value: '9',
    numericValue: 9
  });
  assert.equal(fallbackGreaterOrEquals.sql, 'TRUE');
  assert.deepEqual(fallbackGreaterOrEquals.params, []);
});

test('compilePostgresFilterRulesGuardPredicate: combines guard predicates and preserves params order', () => {
  const compiled = compilePostgresFilterRulesGuardPredicate([
    { key: 'name', op: 'contains', valueNormalized: 'alpha' },
    { key: 'foo', op: 'not_equals', valueNormalized: 'bar' },
    { key: 'style', op: 'exists', valueNormalized: '' }
  ]);

  assert.equal(compiled.sql, '(TRUE) AND (lower(jsonb_extract_path_text(base.tags_jsonb, ?)) <> ?) AND (TRUE)');
  assert.deepEqual(compiled.params, [
    'foo', 'bar'
  ]);
});

test('buildFilterMatchBatchResults evaluates multiple requests against the same candidate set', () => {
  const items = [
    {
      osmKey: 'way/101',
      sourceTags: { 'building:levels': '1' },
      archiInfo: null
    },
    {
      osmKey: 'way/102',
      sourceTags: { 'building:levels': '4' },
      archiInfo: null
    },
    {
      osmKey: 'way/103',
      sourceTags: { 'building:levels': '9' },
      archiInfo: null
    }
  ];

  const results = buildFilterMatchBatchResults(items, [
    {
      id: 'levels-1',
      rulesHash: 'hash-1',
      maxResults: 100,
      rules: [
        { key: 'building:levels', op: 'equals', value: '1', valueNormalized: '1', numericValue: null }
      ]
    },
    {
      id: 'levels-3-8',
      rulesHash: 'hash-2',
      maxResults: 100,
      rules: [
        { key: 'building:levels', op: 'greater_or_equals', value: '3', valueNormalized: '3', numericValue: 3 },
        { key: 'building:levels', op: 'less_than', value: '9', valueNormalized: '9', numericValue: 9 }
      ]
    }
  ], {
    bboxHash: 'bbox:demo',
    elapsedMs: 123
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].id, 'levels-1');
  assert.deepEqual(results[0].matchedKeys, ['way/101']);
  assert.equal(results[0].meta.rulesHash, 'hash-1');
  assert.equal(results[0].meta.bboxHash, 'bbox:demo');
  assert.equal(results[0].meta.elapsedMs, 123);

  assert.equal(results[1].id, 'levels-3-8');
  assert.deepEqual(results[1].matchedKeys, ['way/102']);
  assert.equal(results[1].meta.rulesHash, 'hash-2');
  assert.equal(results[1].meta.truncated, false);
});

test('buildFilterMatchBatchResults prefers local archi info over raw OSM tags', () => {
  const items = [
    {
      osmKey: 'way/201',
      sourceTags: { style: 'OSM Style', material: 'brick', colour: 'blue' },
      archiInfo: { style: 'Local Style', material: 'stone', colour: 'red' }
    }
  ];

  const styleResult = buildFilterMatchBatchResults(items, [
    {
      id: 'style-local',
      rulesHash: 'hash-style',
      maxResults: 100,
      rules: [
        { key: 'style', op: 'equals', value: 'Local Style', valueNormalized: 'local style', numericValue: null }
      ]
    }
  ]);
  assert.deepEqual(styleResult[0].matchedKeys, ['way/201']);

  const materialResult = buildFilterMatchBatchResults(items, [
    {
      id: 'material-local',
      rulesHash: 'hash-material',
      maxResults: 100,
      rules: [
        { key: 'material', op: 'equals', value: 'stone', valueNormalized: 'stone', numericValue: null }
      ]
    }
  ]);
  assert.deepEqual(materialResult[0].matchedKeys, ['way/201']);

  const colourResult = buildFilterMatchBatchResults(items, [
    {
      id: 'colour-local',
      rulesHash: 'hash-colour',
      maxResults: 100,
      rules: [
        { key: 'colour', op: 'equals', value: 'red', valueNormalized: 'red', numericValue: null }
      ]
    }
  ]);
  assert.deepEqual(colourResult[0].matchedKeys, ['way/201']);
});

test('buildFilterMatchBatchResults returns actual marker points at and above the low-zoom aggregation cutoff', () => {
  const items = [
    {
      osmKey: 'way/301',
      centerLon: 37.595,
      centerLat: 55.695,
      sourceTags: {},
      archiInfo: null
    },
    {
      osmKey: 'way/302',
      centerLon: 37.615,
      centerLat: 55.715,
      sourceTags: {},
      archiInfo: null
    },
    {
      osmKey: 'way/303',
      centerLon: 37.645,
      centerLat: 55.745,
      sourceTags: {},
      archiInfo: null
    },
    {
      osmKey: 'way/304',
      centerLon: 37.675,
      centerLat: 55.775,
      sourceTags: {},
      archiInfo: null
    }
  ];

  const results = buildFilterMatchBatchResults(items, [
    {
      id: 'markers-all',
      rulesHash: 'hash-markers',
      maxResults: 100,
      rules: []
    }
  ], {
    bbox: {
      west: 37.59,
      south: 55.69,
      east: 37.68,
      north: 55.78
    },
    bboxHash: 'bbox:markers',
    elapsedMs: 7,
    renderMode: 'markers',
    zoomBucket: 5
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].matchedCount, 4);
  assert.equal(results[0].matchedFeatureIds.length, 4);
  assert.equal(results[0].matchedLocations.length, 4);
  assert.deepEqual(results[0].matchedLocations.map((point) => point?.count ?? null), [1, 1, 1, 1]);
  assert.equal(results[0].matchedLocations.every((point) => String(point?.osmKey || '').startsWith('way/')), true);
  assert.equal(results[0].matchedLocations.every((point) => String(point?.osmKey || '').startsWith('cell:') === false), true);
  assert.equal(results[0].meta.truncated, false);
});

test('buildFilterMatchBatchResults aggregates marker fallback only below the low-zoom cutoff', () => {
  const items = [
    {
      osmKey: 'way/401',
      centerLon: 37.6001,
      centerLat: 55.7001,
      sourceTags: {},
      archiInfo: null
    },
    {
      osmKey: 'way/402',
      centerLon: 37.6002,
      centerLat: 55.7002,
      sourceTags: {},
      archiInfo: null
    }
  ];

  const results = buildFilterMatchBatchResults(items, [
    {
      id: 'markers-aggregated',
      rulesHash: 'hash-markers-aggregated',
      maxResults: 100,
      rules: []
    }
  ], {
    bbox: {
      west: 37.59,
      south: 55.69,
      east: 37.68,
      north: 55.78
    },
    bboxHash: 'bbox:markers-aggregated',
    elapsedMs: 7,
    renderMode: 'markers',
    zoomBucket: 4
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].matchedCount, 2);
  assert.equal(results[0].matchedFeatureIds.length, 1);
  assert.equal(results[0].matchedLocations.length, 1);
  assert.equal(results[0].matchedLocations[0]?.count, 2);
  assert.equal(String(results[0].matchedLocations[0]?.osmKey || '').startsWith('cell:'), true);
  assert.equal(results[0].meta.truncated, false);
});
