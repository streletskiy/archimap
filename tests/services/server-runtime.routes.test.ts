const test = require('node:test');
const assert = require('node:assert/strict');

const serverRuntimeRoutesPath = require.resolve('../../src/lib/server/boot/server-runtime.routes');
const authIndexPath = require.resolve('../../src/lib/server/auth');
const appRoutePath = require.resolve('../../src/lib/server/http/app.route');
const adminRoutePath = require.resolve('../../src/lib/server/http/admin.route');
const buildingsRoutePath = require.resolve('../../src/lib/server/http/buildings.route');
const searchRoutePath = require.resolve('../../src/lib/server/http/search.route');
const accountRoutePath = require.resolve('../../src/lib/server/http/account.route');
const contoursStatusRoutePath = require.resolve('../../src/lib/server/http/contours-status.route');

function createDeferredPromise() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {
    promise,
    resolve,
    reject
  };
}

function withTimeout(promise, timeoutMs = 100) {
  let timeoutId = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    })
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function createNoopMiddleware() {
  return (_req, _res, next) => next();
}

function createModuleMock(exports) {
  return {
    id: 'mocked-module',
    filename: 'mocked-module',
    loaded: true,
    exports
  };
}

test('region delete triggers search rebuild without waiting for completion', async (t) => {
  const originalCaches = new Map([
    [authIndexPath, require.cache[authIndexPath]],
    [appRoutePath, require.cache[appRoutePath]],
    [adminRoutePath, require.cache[adminRoutePath]],
    [buildingsRoutePath, require.cache[buildingsRoutePath]],
    [searchRoutePath, require.cache[searchRoutePath]],
    [accountRoutePath, require.cache[accountRoutePath]],
    [contoursStatusRoutePath, require.cache[contoursStatusRoutePath]],
    [serverRuntimeRoutesPath, require.cache[serverRuntimeRoutesPath]]
  ]);

  const captured = {
    adminDeps: null
  };

  require.cache[authIndexPath] = createModuleMock({
    registerAuthRoutes: () => {}
  });
  require.cache[appRoutePath] = createModuleMock({
    registerAppRoutes: () => {}
  });
  require.cache[adminRoutePath] = createModuleMock({
    registerAdminRoutes: (deps) => {
      captured.adminDeps = deps;
    }
  });
  require.cache[buildingsRoutePath] = createModuleMock({
    registerBuildingsRoutes: () => {}
  });
  require.cache[searchRoutePath] = createModuleMock({
    registerSearchRoutes: () => {}
  });
  require.cache[accountRoutePath] = createModuleMock({
    registerAccountRoutes: () => {}
  });
  require.cache[contoursStatusRoutePath] = createModuleMock({
    registerContoursStatusRoute: () => {}
  });

  delete require.cache[serverRuntimeRoutesPath];
  t.after(() => {
    for (const [path, cache] of originalCaches.entries()) {
      if (cache) {
        require.cache[path] = cache;
      } else {
        delete require.cache[path];
      }
    }
  });

  const { registerServerRuntimeRoutes } = require(serverRuntimeRoutesPath);
  const rebuildGate = createDeferredPromise();
  const reloadSchedulesGate = createDeferredPromise();
  const rebuildCalls = [];
  const reloadCalls = [];
  const loggerErrors = [];

  const runtime = {
    app: {},
    config: {
      rootDir: '/repo',
      rawEnv: {},
      sessionSecret: 'secret',
      appBaseUrl: 'https://example.com',
      appDisplayName: 'ArchiMap',
      registrationEnabled: true,
      userEditRequiresPermission: true,
      registrationCodeTtlMinutes: 15,
      registrationCodeResendCooldownSec: 60,
      registrationCodeMaxAttempts: 6,
      registrationMinPasswordLength: 8,
      passwordResetTtlMinutes: 60,
      paths: {
        dataDir: '/repo/data'
      }
    },
    rateLimiters: {
      publicApiRateLimiter: createNoopMiddleware(),
      adminApiRateLimiter: createNoopMiddleware(),
      buildingsReadRateLimiter: createNoopMiddleware(),
      buildingsWriteRateLimiter: createNoopMiddleware(),
      filterDataRateLimiter: createNoopMiddleware(),
      filterDataBboxRateLimiter: createNoopMiddleware(),
      filterMatchesRateLimiter: createNoopMiddleware(),
      searchRateLimiter: createNoopMiddleware(),
      accountReadRateLimiter: createNoopMiddleware(),
      contoursStatusRateLimiter: createNoopMiddleware()
    },
    createSimpleRateLimiter: () => createNoopMiddleware(),
    logger: {
      info() {},
      error(code, payload) {
        loggerErrors.push({ code, payload });
      }
    },
    normalizeMapConfig: () => ({}),
    getBuildInfo: () => ({}),
    getAppVersion: () => '1.0.0',
    getRegistrationEnabled: () => true,
    getUserEditRequiresPermission: () => true,
    dataSettingsService: {},
    styleRegionOverridesService: {},
    getFilterTagKeysCached: async () => [],
    getAllFilterTagKeysCached: async () => [],
    isFilterTagKeysRebuildInProgress: () => false,
    requireAuth: createNoopMiddleware(),
    requireAdmin: createNoopMiddleware(),
    getSessionEditActorKey: () => 'admin@example.com',
    normalizeUserEditStatus: (value) => value,
    sanitizeFieldText: (value) => value,
    sanitizeYearBuilt: (value) => value,
    sanitizeLevels: (value) => value,
    getMergedInfoRow: async () => null,
    getOsmContourRow: async () => null,
    reassignUserEdit: async () => ({}),
    deleteUserEdit: async () => ({}),
    enqueueSearchIndexRefresh: () => {},
    refreshDesignRefSuggestionsCache: () => {},
    ARCHI_FIELD_SET: new Set(),
    registrationCodeHtmlTemplate: () => '',
    registrationCodeTextTemplate: () => '',
    passwordResetHtmlTemplate: () => '',
    passwordResetTextTemplate: () => '',
    smtpTestHtmlTemplate: () => '',
    smtpTestTextTemplate: () => '',
    appSettingsService: {},
    applyFilterTagAllowlistSnapshot: () => {},
    applyGeneralSettingsSnapshot: () => {},
    applySmtpSettingsSnapshot: () => {},
    getAppDisplayName: () => 'ArchiMap',
    getAppBaseUrl: () => 'https://example.com',
    osmSyncService: {},
    db: {},
    getBuildingSearchResults: async () => [],
    syncWorkers: {
      reloadSchedules: () => {
        reloadCalls.push('reload');
        return reloadSchedulesGate.promise;
      },
      requestRegionSync: () => ({}),
      isSyncInProgress: () => false
    },
    migrateRegionPmtilesFile: () => {},
    removeRegionPmtilesFiles: () => {},
    resetFilterTagKeysCache: () => {},
    scheduleFilterTagKeysCacheRebuild: () => {},
    rebuildSearchIndex: (reason) => {
      rebuildCalls.push(reason);
      return rebuildGate.promise;
    }
  };

  registerServerRuntimeRoutes(runtime);
  assert.ok(captured.adminDeps);

  const callbackPromise = captured.adminDeps.onDataRegionsSaved({
    action: 'delete',
    deleted: {
      region: {
        id: 42
      }
    }
  });

  const result = await withTimeout(callbackPromise, 100);
  assert.equal(result?.timeout, undefined);
  assert.deepEqual(rebuildCalls, ['region-delete:42']);
  assert.deepEqual(reloadCalls, ['reload']);
  assert.equal(loggerErrors.length, 0);

  rebuildGate.resolve();
  reloadSchedulesGate.resolve();
  await callbackPromise;
});
