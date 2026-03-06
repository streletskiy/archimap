const test = require('node:test');
const assert = require('node:assert/strict');

const { createRuntimeSettingsCache } = require('../../src/lib/server/services/runtime-settings-cache.service');

test('createRuntimeSettingsCache returns fallback value immediately and refreshes once for concurrent callers', async () => {
  let loadCalls = 0;
  let releaseLoad = null;
  const loadPromise = new Promise((resolve) => {
    releaseLoad = resolve;
  });

  const cache = createRuntimeSettingsCache({
    fallback: { value: 'fallback' },
    load: async () => {
      loadCalls += 1;
      await loadPromise;
      return { config: { value: 'db' } };
    },
    normalize: (config) => ({ value: String(config.value || '').trim() })
  });

  assert.deepEqual(cache.getValue(), { value: 'fallback' });

  const refreshA = cache.refresh();
  const refreshB = cache.refresh();

  await Promise.resolve();
  assert.equal(loadCalls, 1);
  assert.strictEqual(refreshA, refreshB);

  releaseLoad();
  await refreshA;

  assert.deepEqual(cache.getValue(), { value: 'db' });
});

test('createRuntimeSettingsCache applySnapshot can preserve previous values via normalizer', () => {
  const cache = createRuntimeSettingsCache({
    fallback: {
      host: 'smtp.example.com',
      pass: 'saved-pass'
    },
    load: async () => ({ config: null }),
    normalize: (config, previous) => ({
      host: String(config.host || previous.host || '').trim(),
      pass: config.keepPassword === false
        ? ''
        : String(config.pass || previous.pass || '').trim()
    })
  });

  cache.applySnapshot({
    host: 'smtp-next.example.com'
  });

  assert.deepEqual(cache.getValue(), {
    host: 'smtp-next.example.com',
    pass: 'saved-pass'
  });
});
