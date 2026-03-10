const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadFilterWorkerDispatcher() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'filter-worker-dispatcher.js');
  return import(pathToFileURL(modulePath).href);
}

test('filter worker dispatcher lazily creates and reuses the worker service', async () => {
  const { createFilterWorkerDispatcher } = await loadFilterWorkerDispatcher();
  let factoryCalls = 0;
  const requests = [];
  let destroyCalls = 0;

  const dispatcher = createFilterWorkerDispatcher({
    serviceFactory: () => {
      factoryCalls += 1;
      return {
        request(type, payload) {
          requests.push({ type, payload });
          return Promise.resolve({ ok: true, type, payload });
        },
        destroy() {
          destroyCalls += 1;
        }
      };
    }
  });

  const first = await dispatcher.request('prepare-rules', { rules: [{ key: 'name' }] });
  const second = await dispatcher.request('prepare-rules', { rules: [{ key: 'style' }] });

  assert.equal(factoryCalls, 1);
  assert.equal(requests.length, 2);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  dispatcher.destroy();
  assert.equal(destroyCalls, 1);
});
