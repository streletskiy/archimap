const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadFilterUrlStateModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'client', 'filterUrlState.ts');
  return import(pathToFileURL(modulePath).href);
}

function encodeLegacyFilterLayers(filters) {
  const MODE_TO_CODE = { and: 'a', or: 'o', layer: 'l' };
  const OP_TO_CODE = {
    contains: 'c',
    equals: 'e',
    not_equals: 'n',
    starts_with: 's',
    exists: 'x',
    not_exists: 'X',
    greater_than: 'g',
    greater_or_equals: 'G',
    less_than: 'l',
    less_or_equals: 'L'
  };
  const VALUELESS_RULE_OPS = new Set(['exists', 'not_exists']);
  const payload = [
    1,
    filters.map((layer) => [
      MODE_TO_CODE[layer.mode] || MODE_TO_CODE.and,
      String(layer.color || '').replace(/^#/, ''),
      layer.rules.map((rule) => (
        VALUELESS_RULE_OPS.has(rule.op)
          ? [rule.key, OP_TO_CODE[rule.op] || OP_TO_CODE.contains]
          : [rule.key, OP_TO_CODE[rule.op] || OP_TO_CODE.contains, rule.value]
      ))
    ])
  ];
  return Buffer
    .from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

test('encodeFilterLayersForUrl and decodeFilterLayersFromUrl roundtrip layer filters', async () => {
  const { decodeFilterLayersFromUrl, encodeFilterLayersForUrl } = await loadFilterUrlStateModule();
  const filters = [
    {
      color: '#f59e0b',
      mode: 'and',
      rules: [
        { key: 'building:levels', op: 'greater_or_equals', value: '5' },
        { key: 'name', op: 'contains', value: 'tower' }
      ]
    },
    {
      color: '#3b82f6',
      mode: 'layer',
      rules: [
        { key: 'building:material', op: 'equals', value: 'brick' }
      ]
    }
  ];

  const encoded = encodeFilterLayersForUrl(filters);
  assert.match(encoded, /^[A-Za-z0-9\-_]+$/);
  const decoded = decodeFilterLayersFromUrl(encoded);
  assert.deepEqual(decoded, [
    {
      priority: 0,
      color: '#f59e0b',
      mode: 'and',
      rules: [
        { key: 'building:levels', op: 'greater_or_equals', value: '5' },
        { key: 'name', op: 'contains', value: 'tower' }
      ]
    },
    {
      priority: 1,
      color: '#3b82f6',
      mode: 'layer',
      rules: [
        { key: 'building:material', op: 'equals', value: 'brick' }
      ]
    }
  ]);
});

test('decodeFilterLayersFromUrl does not support legacy v1 links', async () => {
  const { decodeFilterLayersFromUrl } = await loadFilterUrlStateModule();
  const legacyEncoded = encodeLegacyFilterLayers([
    {
      color: '#f59e0b',
      mode: 'and',
      rules: [
        { key: 'building:levels', op: 'greater_or_equals', value: '5' }
      ]
    }
  ]);
  assert.equal(decodeFilterLayersFromUrl(legacyEncoded), null);
});

test('decodeFilterLayersFromUrl returns null for invalid payload', async () => {
  const { decodeFilterLayersFromUrl } = await loadFilterUrlStateModule();
  assert.equal(decodeFilterLayersFromUrl('not-a-valid-filter-state'), null);
});

