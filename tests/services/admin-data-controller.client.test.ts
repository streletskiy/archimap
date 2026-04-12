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

test('stale region settings refresh does not restore an old sync error after optimistic queueing', async () => {
  const { createAdminDataController } = await loadControllerModule();
  const staleLoadGate = createDeferred();
  const syncGate = createDeferred();
  let dataRequestCount = 0;

  const staleRegion = {
    id: 77,
    slug: 'demo-region',
    name: 'Demo Region',
    sourceType: 'extract',
    searchQuery: 'Demo',
    extractSource: 'geofabrik',
    extractId: 'demo/region',
    extractLabel: 'Demo Region',
    extractResolutionStatus: 'resolved',
    extractResolutionError: null,
    canSync: true,
    enabled: true,
    autoSyncEnabled: true,
    autoSyncOnStart: false,
    autoSyncIntervalHours: 24,
    pmtilesMinZoom: 13,
    pmtilesMaxZoom: 16,
    sourceLayer: 'buildings',
    lastSyncStatus: 'failed',
    lastSyncError: 'Sync interrupted by process restart',
    lastSuccessfulSyncAt: '2026-04-10T00:00:00.000Z',
    sourceDataUpdatedAt: '2026-04-10T00:00:00.000Z',
    latestSourceDataUpdatedAt: null,
    upstreamCheckedAt: '2026-04-11T00:00:00.000Z',
    upstreamStatus: 'update_available',
    upstreamError: null,
    updateAvailable: true,
    lastSyncFinishedAt: '2026-04-11T00:00:00.000Z',
    nextSyncAt: '2026-04-12T00:00:00.000Z',
    pmtilesBytes: 1024,
    dbBytes: 2048,
    dbBytesApproximate: false,
    bounds: null
  };

  const queuedRegion = {
    ...staleRegion,
    lastSyncStatus: 'queued',
    lastSyncError: null
  };

  mock.method(globalThis, 'fetch', async (input, init: LooseRecord = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();

    if (method === 'GET' && url === '/api/admin/app-settings/data') {
      dataRequestCount += 1;
      if (dataRequestCount === 1) {
        return staleLoadGate.promise;
      }
      return createJsonResponse({
        ok: true,
        item: {
          source: 'db',
          bootstrap: { completed: true, source: null },
          regions: [queuedRegion],
          filterTags: {
            source: 'default',
            allowlist: [],
            defaultAllowlist: [],
            availableKeys: [],
            updatedBy: null,
            updatedAt: null
          },
          filterPresets: {
            source: 'db',
            items: []
          }
        }
      });
    }

    if (method === 'POST' && url.endsWith('/api/admin/app-settings/data/regions/77/sync-now')) {
      return syncGate.promise;
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  });

  try {
    const controller = createAdminDataController();
    controller.dataSettings.set({
      source: 'db',
      bootstrap: { completed: true, source: null },
      regions: [staleRegion],
      filterTags: {
        source: 'default',
        allowlist: [],
        defaultAllowlist: [],
        availableKeys: [],
        updatedBy: null,
        updatedAt: null
      },
      filterPresets: {
        source: 'db',
        items: []
      }
    });
    controller.initialized.set(true);

    const staleLoadPromise = controller.loadDataSettings({
      preserveSelection: false,
      ignoreUnsavedFilterTags: true
    });

    const syncPromise = controller.syncRegionNow(77);

    let region = get(controller.dataSettings).regions.find((item) => item.id === 77);
    assert.equal(region?.lastSyncStatus, 'queued');
    assert.equal(region?.lastSyncError, null);

    staleLoadGate.resolve(createJsonResponse({
      ok: true,
      item: {
        source: 'db',
        bootstrap: { completed: true, source: null },
        regions: [staleRegion],
        filterTags: {
          source: 'default',
          allowlist: [],
          defaultAllowlist: [],
          availableKeys: [],
          updatedBy: null,
          updatedAt: null
        },
        filterPresets: {
          source: 'db',
          items: []
        }
      }
    }));

    await staleLoadPromise;

    region = get(controller.dataSettings).regions.find((item) => item.id === 77);
    assert.equal(region?.lastSyncStatus, 'queued');
    assert.equal(region?.lastSyncError, null);

    syncGate.resolve(createJsonResponse({
      ok: true,
      item: {
        queued: true
      }
    }));

    await syncPromise;
    await Promise.resolve();

    region = get(controller.dataSettings).regions.find((item) => item.id === 77);
    assert.equal(region?.lastSyncStatus, 'queued');
    assert.equal(region?.lastSyncError, null);

    controller.dataSettings.set({
      source: 'db',
      bootstrap: { completed: true, source: null },
      regions: [{ ...queuedRegion, lastSyncStatus: 'idle' }],
      filterTags: {
        source: 'default',
        allowlist: [],
        defaultAllowlist: [],
        availableKeys: [],
        updatedBy: null,
        updatedAt: null
      },
      filterPresets: {
        source: 'db',
        items: []
      }
    });
    await Promise.resolve();
  } finally {
    mock.restoreAll();
  }
});

test('stale upstream status refresh does not clear a live queued sync state', async () => {
  const { createAdminDataController } = await loadControllerModule();
  const upstreamGate = createDeferred();

  const idleRegion = {
    id: 77,
    slug: 'demo-region',
    name: 'Demo Region',
    sourceType: 'extract',
    searchQuery: 'Demo',
    extractSource: 'geofabrik',
    extractId: 'demo/region',
    extractLabel: 'Demo Region',
    extractResolutionStatus: 'resolved',
    extractResolutionError: null,
    canSync: true,
    enabled: true,
    autoSyncEnabled: true,
    autoSyncOnStart: false,
    autoSyncIntervalHours: 24,
    pmtilesMinZoom: 13,
    pmtilesMaxZoom: 16,
    sourceLayer: 'buildings',
    lastSyncStatus: 'idle',
    lastSyncError: null,
    lastSuccessfulSyncAt: '2026-04-10T00:00:00.000Z',
    sourceDataUpdatedAt: '2026-04-10T00:00:00.000Z',
    latestSourceDataUpdatedAt: null,
    upstreamCheckedAt: '2026-04-10T01:00:00.000Z',
    upstreamStatus: 'unknown',
    upstreamError: null,
    updateAvailable: false,
    lastSyncFinishedAt: '2026-04-10T00:00:00.000Z',
    nextSyncAt: '2026-04-12T00:00:00.000Z',
    pmtilesBytes: 1024,
    dbBytes: 2048,
    dbBytesApproximate: false,
    bounds: null
  };

  const queuedRegion = {
    ...idleRegion,
    lastSyncStatus: 'queued',
    lastSyncError: null
  };

  const staleUpstreamRegion = {
    ...idleRegion,
    latestSourceDataUpdatedAt: '2026-04-11T02:00:00.000Z',
    upstreamCheckedAt: '2026-04-11T02:05:00.000Z',
    upstreamStatus: 'update_available',
    updateAvailable: true
  };

  mock.method(globalThis, 'fetch', async (input, init: LooseRecord = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();

    if (method === 'GET' && url.startsWith('/api/admin/app-settings/data/regions/upstream-status?')) {
      return upstreamGate.promise;
    }

    if (method === 'POST' && url.endsWith('/api/admin/app-settings/data/regions/77/sync-now')) {
      return createJsonResponse({
        ok: true,
        item: {
          queued: true
        }
      });
    }

    if (method === 'GET' && url === '/api/admin/app-settings/data') {
      return createJsonResponse({
        ok: true,
        item: {
          source: 'db',
          bootstrap: { completed: true, source: null },
          regions: [queuedRegion],
          filterTags: {
            source: 'default',
            allowlist: [],
            defaultAllowlist: [],
            availableKeys: [],
            updatedBy: null,
            updatedAt: null
          },
          filterPresets: {
            source: 'db',
            items: []
          }
        }
      });
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  });

  try {
    const controller = createAdminDataController();
    controller.dataSettings.set({
      source: 'db',
      bootstrap: { completed: true, source: null },
      regions: [idleRegion],
      filterTags: {
        source: 'default',
        allowlist: [],
        defaultAllowlist: [],
        availableKeys: [],
        updatedBy: null,
        updatedAt: null
      },
      filterPresets: {
        source: 'db',
        items: []
      }
    });
    controller.initialized.set(true);

    const upstreamPromise = controller.refreshRegionUpstreamStatuses([77], {
      silent: true,
      forceRefresh: true
    });

    await controller.syncRegionNow(77);

    let region = get(controller.dataSettings).regions.find((item) => item.id === 77);
    assert.equal(region?.lastSyncStatus, 'queued');
    assert.equal(region?.latestSourceDataUpdatedAt, null);

    upstreamGate.resolve(createJsonResponse({
      ok: true,
      items: [staleUpstreamRegion]
    }));

    await upstreamPromise;
    await Promise.resolve();

    region = get(controller.dataSettings).regions.find((item) => item.id === 77);
    assert.equal(region?.lastSyncStatus, 'queued');
    assert.equal(region?.latestSourceDataUpdatedAt, '2026-04-11T02:00:00.000Z');
    assert.equal(region?.upstreamStatus, 'update_available');
  } finally {
    mock.restoreAll();
  }
});
