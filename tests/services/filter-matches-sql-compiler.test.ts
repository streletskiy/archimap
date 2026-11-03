const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFilterMatchBatchResults,
  compilePostgresFilterRulePredicate,
  compilePostgresFilterRulesPredicate,
  compilePostgresFilterRuleGuardPredicate,
  compilePostgresFilterRulesGuardPredicate
} = require('../../src/lib/server/http/buildings.route');

test('SQL filter compilation parameterizes values and keeps text comparisons literal', () => {
  const prefix = compilePostgresFilterRulePredicate({ key: "quote'key", op: 'starts_with', valueNormalized: 'a_%' });
  assert.deepEqual(prefix.params, ["quote'key", 'a_%']);
  assert.match(prefix.sql, /strpos[\s\S]*= 1$/);
  assert.doesNotMatch(prefix.sql, /LIKE|quote'key|a_%/);
  const empty = compilePostgresFilterRulePredicate({ key: 'foo', op: 'equals', valueNormalized: '' });
  assert.deepEqual(empty.params, ['foo', '']);
  assert.doesNotMatch(empty.sql, /ELSE NULL::text/);
});

test('SQL filter compilation preserves common override keys and JS alias precedence', () => {
  const alias = compilePostgresFilterRulePredicate({ key: 'building:colour', op: 'equals', valueNormalized: 'red' });
  assert.match(alias.sql, /src\.colour/);
  assert.deepEqual(alias.params, ['building:colour', 'colour', 'red']);
  const style = compilePostgresFilterRulePredicate({ key: 'style', op: 'exists' });
  assert.deepEqual(style.params, ['style']);
  const levels = compilePostgresFilterRulePredicate({ key: 'building:levels', op: 'greater_or_equals', value: '5', numericValue: 5 });
  assert.match(levels.sql, /src\.item_levels/);
  assert.deepEqual(levels.params, ['building:levels', 5]);
});

test('SQL filter compilation combines rules in order and rejects unsupported operators', () => {
  const combined = compilePostgresFilterRulesPredicate([
    { key: 'name', op: 'contains', valueNormalized: 'alpha' },
    { key: 'foo', op: 'not_equals', valueNormalized: 'bar' },
    { key: 'style', op: 'exists' }
  ]);
  assert.deepEqual(combined.params, ['name', 'alpha', 'foo', 'bar', 'style']);
  assert.match(combined.sql, /^\([\s\S]+\) AND \([\s\S]+\) AND \([\s\S]+\)$/);
  assert.deepEqual(compilePostgresFilterRulesPredicate([]), { sql: 'TRUE', params: [] });
  assert.throws(() => compilePostgresFilterRulePredicate({ key: 'name', op: 'regex' }), /Unsupported filter rule operator/);
});

test('candidate guards never discard an architectural override match', () => {
  for (const key of ['name', 'archi.style', 'building:levels', 'building:material:concrete']) {
    assert.deepEqual(compilePostgresFilterRuleGuardPredicate({ key, op: 'equals', valueNormalized: 'x' }), { sql: 'TRUE', params: [] });
  }
  const combined = compilePostgresFilterRulesGuardPredicate([
    { key: 'name', op: 'contains', valueNormalized: 'alpha' },
    { key: 'foo', op: 'not_equals', valueNormalized: 'bar' },
    { key: 'style', op: 'exists' }
  ]);
  assert.deepEqual(combined.params, ['foo', 'bar']);
  assert.match(combined.sql, /^\(TRUE\) AND [\s\S]+ AND \(TRUE\)$/);
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

  const results = buildFilterMatchBatchResults(
    items,
    [
      {
        id: 'levels-1',
        rulesHash: 'hash-1',
        maxResults: 100,
        rules: [{ key: 'building:levels', op: 'equals', value: '1', valueNormalized: '1', numericValue: null }]
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
    ],
    {
      bboxHash: 'bbox:demo',
      elapsedMs: 123
    }
  );

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
      rules: [{ key: 'style', op: 'equals', value: 'Local Style', valueNormalized: 'local style', numericValue: null }]
    }
  ]);
  assert.deepEqual(styleResult[0].matchedKeys, ['way/201']);

  const materialResult = buildFilterMatchBatchResults(items, [
    {
      id: 'material-local',
      rulesHash: 'hash-material',
      maxResults: 100,
      rules: [{ key: 'material', op: 'equals', value: 'stone', valueNormalized: 'stone', numericValue: null }]
    }
  ]);
  assert.deepEqual(materialResult[0].matchedKeys, ['way/201']);

  const colourResult = buildFilterMatchBatchResults(items, [
    {
      id: 'colour-local',
      rulesHash: 'hash-colour',
      maxResults: 100,
      rules: [{ key: 'colour', op: 'equals', value: 'red', valueNormalized: 'red', numericValue: null }]
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

  const results = buildFilterMatchBatchResults(
    items,
    [
      {
        id: 'markers-all',
        rulesHash: 'hash-markers',
        maxResults: 100,
        rules: []
      }
    ],
    {
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
    }
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].matchedCount, 4);
  assert.equal(results[0].matchedFeatureIds.length, 4);
  assert.equal(results[0].matchedLocations.length, 4);
  assert.deepEqual(
    results[0].matchedLocations.map((point) => point?.count ?? null),
    [1, 1, 1, 1]
  );
  assert.equal(
    results[0].matchedLocations.every((point) => String(point?.osmKey || '').startsWith('way/')),
    true
  );
  assert.equal(
    results[0].matchedLocations.every((point) => String(point?.osmKey || '').startsWith('cell:') === false),
    true
  );
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

  const results = buildFilterMatchBatchResults(
    items,
    [
      {
        id: 'markers-aggregated',
        rulesHash: 'hash-markers-aggregated',
        maxResults: 100,
        rules: []
      }
    ],
    {
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
    }
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].matchedCount, 2);
  assert.equal(results[0].matchedFeatureIds.length, 1);
  assert.equal(results[0].matchedLocations.length, 1);
  assert.equal(results[0].matchedLocations[0]?.count, 2);
  assert.equal(String(results[0].matchedLocations[0]?.osmKey || '').startsWith('cell:'), true);
  assert.equal(results[0].meta.truncated, false);
});
