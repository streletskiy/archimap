const assert = require('node:assert/strict');
const { mock } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const { get } = require('svelte/store');

function createJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject
  };
}

async function loadControllerModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'components', 'admin', 'admin-data-controller.ts');
  return import(pathToFileURL(modulePath).href);
}

test('new region save stays pending until the create request resolves and skips the heavy refresh path', async () => {
  const { createAdminDataController } = await loadControllerModule();
  const saveGate = createDeferred();
  const fetchCalls = [];

  mock.method(globalThis, 'fetch', async (input, init: LooseRecord = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    fetchCalls.push({ url, method });

    if (method === 'POST' && url.endsWith('/api/admin/app-settings/data/regions')) {
      return saveGate.promise;
    }

    if (method === 'POST' && /\/api\/admin\/app-settings\/data\/regions\/\d+\/sync-now$/.test(url)) {
      return createJsonResponse({ ok: true, item: { queued: true } });
    }

    if (method === 'GET' && url.endsWith('/api/admin/app-settings/data')) {
      throw new Error('unexpected full data refresh');
    }

    return createJsonResponse({ ok: true, item: { regions: [] } });
  });

  try {
    const controller = createAdminDataController();
    controller.patchRegionDraft({
      name: 'Test Region',
      slug: 'test-region',
      searchQuery: 'Antarctica',
      extractSource: 'geofabrik',
      extractId: 'geofabrik_antarctica',
      extractLabel: 'antarctica',
      sourceLayer: 'buildings',
      autoSyncEnabled: true,
      autoSyncOnStart: false,
      autoSyncIntervalHours: 24,
      pmtilesMinZoom: 13,
      pmtilesMaxZoom: 16
    });

    const savePromise = controller.saveDataRegion({
      preventDefault() {}
    });

    assert.equal(get(controller.regionSaving), true);

    saveGate.resolve(
      createJsonResponse({
        ok: true,
        item: {
          id: 101,
          slug: 'test-region',
          name: 'Test Region',
          sourceType: 'extract',
          searchQuery: 'Antarctica',
          extractSource: 'geofabrik',
          extractId: 'geofabrik_antarctica',
          extractLabel: 'antarctica',
          enabled: true,
          autoSyncEnabled: true,
          autoSyncOnStart: false,
          autoSyncIntervalHours: 24,
          pmtilesMinZoom: 13,
          pmtilesMaxZoom: 16,
          sourceLayer: 'buildings',
          lastSyncStatus: 'idle',
          lastSyncError: null
        }
      })
    );

    await savePromise;

    assert.equal(get(controller.regionSaving), false);
    assert.deepEqual(
      fetchCalls.map((call) => `${call.method} ${call.url}`),
      [
        'POST /api/admin/app-settings/data/regions',
        'POST /api/admin/app-settings/data/regions/101/sync-now'
      ]
    );
  } finally {
    mock.restoreAll();
  }
});

test('background region run refresh preserves current history rows without enabling skeleton loading', async () => {
  const { createAdminDataController } = await loadControllerModule();
  const runsGate = createDeferred();

  mock.method(globalThis, 'fetch', async (input, init: LooseRecord = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();

    if (method === 'GET' && url.startsWith('/api/admin/app-settings/data/regions/77/runs?')) {
      return runsGate.promise;
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  });

  try {
    const controller = createAdminDataController();
    controller.regionRuns.set([
      {
        id: 501,
        status: 'running',
        triggerReason: 'manual'
      }
    ]);
    controller.regionRunsTotal.set(1);
    controller.regionRunsPage.set(1);
    controller.regionRunsPageCount.set(1);

    const loadPromise = controller.loadRegionRuns(77, 1, {
      background: true
    });

    assert.equal(get(controller.regionRunsLoading), false);
    assert.deepEqual(get(controller.regionRuns), [
      {
        id: 501,
        status: 'running',
        triggerReason: 'manual'
      }
    ]);

    runsGate.resolve(createJsonResponse({
      items: [
        {
          id: 502,
          status: 'running',
          triggerReason: 'manual'
        }
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      pageCount: 1
    }));

    await loadPromise;

    assert.equal(get(controller.regionRunsLoading), false);
    assert.deepEqual(get(controller.regionRuns), [
      {
        id: 502,
        status: 'running',
        triggerReason: 'manual'
      }
    ]);
  } finally {
    mock.restoreAll();
  }
});
