const test = require('node:test');
const assert = require('node:assert/strict');

const { createMiniApp, jsonMiddleware } = require('../../src/lib/server/infra/mini-app.infra');
const { registerBuildingsRoutes } = require('../../src/lib/server/http/buildings.route');
const {
  normalizeUserEditStatus,
  sanitizeArchiPayload,
  sanitizeEditedFields
} = require('../../src/lib/server/services/edits.service');

function createStatementStub() {
  return {
    all: () => [],
    get: () => null,
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    iterate: function* () {},
    raw() {
      return this;
    },
    pluck() {
      return this;
    },
    bind() {
      return this;
    }
  };
}

async function startServer(app): Promise<import('node:http').Server> {
  return await new Promise<import('node:http').Server>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function stopServer(server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
}

function createRouteApp(options: LooseRecord = {}) {
  const app = createMiniApp();
  app.use(jsonMiddleware());

  const savedEdits: LooseRecord[] = [];
  const refreshCalls: string[] = [];
  let resolveRefresh: (() => void) | null = null;
  const refreshPromise = new Promise<void>((resolve) => {
    resolveRefresh = resolve;
  });

  registerBuildingsRoutes({
    app,
    db: {
      provider: 'sqlite',
      transaction(fn) {
        return fn;
      },
      prepare() {
        return createStatementStub();
      }
    },
    rtreeState: { ready: true },
    buildingsReadRateLimiter: (_req, _res, next) => next(),
    buildingsWriteRateLimiter: (_req, _res, next) => next(),
    filterDataRateLimiter: (_req, _res, next) => next(),
    filterDataBboxRateLimiter: (_req, _res, next) => next(),
    filterMatchesRateLimiter: (_req, _res, next) => next(),
    requireCsrfSession: (_req, _res, next) => next(),
    requireAuth: (_req, _res, next) => next(),
    requireBuildingEditPermission: (_req, _res, next) => next(),
    getSessionEditActorKey: () => 'editor@example.com',
    applyPersonalEditsToFilterItems: () => [],
    isFilterTagAllowed: () => true,
    rowToFeature: () => null,
    attachInfoToFeatures: () => {},
    applyUserEditRowToInfo: (merged, personal) => ({ ...(merged || {}), ...(personal || {}) }),
    getMergedInfoRow: async () => null,
    getOsmContourRow: async () => options.currentContour || {
      tags_json: JSON.stringify({ building: 'yes' }),
      updated_at: '2026-03-25T00:00:00Z'
    },
    getLatestUserEditRow: async () => null,
    normalizeUserEditStatus,
    sanitizeArchiPayload,
    sanitizeEditedFields,
    supersedePendingUserEdits: async () => {},
    getDesignRefSuggestionsCached: async () => [],
    refreshDesignRefSuggestionsCache: () => {
      refreshCalls.push('building-info-save');
      return options.refreshPromise || refreshPromise;
    },
    buildingsRepository: {
      insertPendingUserEdit: async (values = {}) => {
        savedEdits.push(values);
        return savedEdits.length;
      },
      updatePendingUserEditById: async () => {}
    }
  });

  return {
    app,
    savedEdits,
    refreshCalls,
    resolveRefresh: resolveRefresh || (() => {}),
    refreshPromise
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

test('building-info save does not refresh design-ref suggestions for unrelated edits', async (t) => {
  const { app, refreshCalls } = createRouteApp();
  const server = await startServer(app);
  t.after(async () => stopServer(server));

  const port = (() => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server is not listening');
    return address.port;
  })();

  const response = await fetch(`http://127.0.0.1:${port}/api/building-info`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      osmType: 'way',
      osmId: 101,
      style: 'omani',
      editedFields: ['style']
    })
  });

  assert.equal(response.status, 200);
  assert.equal(refreshCalls.length, 0);
});

test('building-info save queues design-ref suggestion refresh without blocking the response', async (t) => {
  let resolveRefresh: (() => void) | null = null;
  const refreshPromise = new Promise<void>((resolve) => {
    resolveRefresh = resolve;
  });

  const { app, refreshCalls, savedEdits } = createRouteApp({ refreshPromise });
  const server = await startServer(app);
  t.after(async () => stopServer(server));

  const port = (() => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server is not listening');
    return address.port;
  })();

  const responsePromise = fetch(`http://127.0.0.1:${port}/api/building-info`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      osmType: 'way',
      osmId: 102,
      designRef: '1-464',
      editedFields: ['designRef']
    })
  });

  const response = await withTimeout(responsePromise, 1000);
  assert.equal(response.status, 200);
  assert.equal(refreshCalls.length, 1);
  assert.equal(savedEdits.length, 1);
  assert.equal(savedEdits[0]?.design_ref, '1-464');

  resolveRefresh?.();
  await refreshPromise;
});
