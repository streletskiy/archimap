const test = require('node:test');
const assert = require('node:assert/strict');

const { createSearchService } = require('../../services/search.service');

function createNoopDb() {
  return {
    prepare() {
      return {
        all() {
          return [];
        }
      };
    }
  };
}

test('normalizeSearchTokens deduplicates and limits token count', () => {
  const service = createSearchService({ db: createNoopDb() });
  const tokens = service.normalizeSearchTokens('  дом дом, музей!! архитектура стиль стиль  ');
  assert.deepEqual(tokens, ['дом', 'музей', 'архитектура', 'стиль']);
});

test('buildFtsMatchQuery escapes quotes', () => {
  const service = createSearchService({ db: createNoopDb() });
  const query = service.buildFtsMatchQuery(['abc', 'd"e']);
  assert.equal(query, '"abc"* AND "d""e"*');
});

test('getBuildingSearchResults returns empty for short/empty tokens', () => {
  const service = createSearchService({ db: createNoopDb() });
  const result = service.getBuildingSearchResults('   ', 0, 0, 30, 0);
  assert.deepEqual(result, { items: [], nextCursor: null, hasMore: false });
});
