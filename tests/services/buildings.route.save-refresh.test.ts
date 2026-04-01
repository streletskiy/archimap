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

function createFeatureFromRow(row) {
  if (!row) return null;
  const geometryJson = row?.geometry_json ?? row?.source_geometry_json ?? null;
  const tagsJson = row?.tags_json ?? row?.source_tags_json ?? null;
  let geometry;
  try {
    geometry = geometryJson ? JSON.parse(geometryJson) : null;
  } catch {
    geometry = null;
  }
  let tags;
  try {
    tags = tagsJson ? JSON.parse(tagsJson) : {};
  } catch {
    tags = {};
  }
  const featureKind = Object.prototype.hasOwnProperty.call(tags, 'building:part')
    ? 'building_part'
    : 'building';
  return {
    type: 'Feature',
    id: `${row.osm_type}/${row.osm_id}`,
    geometry,
    properties: {
      ...tags,
      osm_type: row.osm_type,
      osm_id: row.osm_id,
      osm_key: `${row.osm_type}/${row.osm_id}`,
      feature_kind: featureKind,
      source_tags: tags,
      source_osm_updated_at: row?.source_osm_updated_at ?? null
    }
  };
}

function createRouteApp(options: LooseRecord = {}) {
  const app = createMiniApp();
  app.use(jsonMiddleware());

  const savedEdits: LooseRecord[] = [];
  const updatedEdits: LooseRecord[] = [];
  const supersedeCalls: LooseRecord[] = [];
  const refreshCalls: string[] = [];
  let resolveRefresh: (() => void) | null = null;
  const refreshPromise = new Promise<void>((resolve) => {
    resolveRefresh = resolve;
  });
  const defaultContour = {
    geometry_json: JSON.stringify({
      type: 'Polygon',
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
    }),
    tags_json: JSON.stringify({ building: 'yes' }),
    updated_at: '2026-03-25T00:00:00Z'
  };
  const hasCurrentContour = Object.prototype.hasOwnProperty.call(options, 'currentContour');
  const hasLatestSnapshot = Object.prototype.hasOwnProperty.call(options, 'latestSnapshot');

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
    rowToFeature: createFeatureFromRow,
    attachInfoToFeatures: () => {},
    applyUserEditRowToInfo: (merged, personal) => ({ ...(merged || {}), ...(personal || {}) }),
    getMergedInfoRow: async () => null,
    getOsmContourRow: async () => (hasCurrentContour ? options.currentContour : defaultContour),
    getLatestUserEditRow: async () => options.latestPendingEdit || null,
    normalizeUserEditStatus,
    sanitizeArchiPayload,
    sanitizeEditedFields,
    supersedePendingUserEdits: async (...args) => {
      supersedeCalls.push(args);
    },
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
      updatePendingUserEditById: async (editId, values = {}) => {
        updatedEdits.push({ editId, values });
      },
      getLatestUserEditSnapshotById: async () => (hasLatestSnapshot ? options.latestSnapshot : null),
      getBuildingById: async () => null,
      getBuildingRegionSlugsById: async () => []
    }
  });

  return {
    app,
    savedEdits,
    updatedEdits,
    supersedeCalls,
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

test('building-info save updates an existing pending edit in place', async (t) => {
  const { app, savedEdits, updatedEdits, supersedeCalls } = createRouteApp({
    latestPendingEdit: {
      id: 501,
      osm_type: 'way',
      osm_id: 5010,
      createdBy: 'editor@example.com',
      edited_fields_json: JSON.stringify(['name']),
      status: 'pending'
    }
  });
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
      osmId: 5010,
      name: 'Updated draft',
      editedFields: ['name']
    })
  });

  assert.equal(response.status, 200);
  assert.equal(savedEdits.length, 0);
  assert.equal(updatedEdits.length, 1);
  assert.equal(Number(updatedEdits[0]?.editId), 501);
  assert.equal(supersedeCalls.length, 1);
  assert.deepEqual(supersedeCalls[0], ['way', 5010, 'editor@example.com', 501]);
});

test('building-info save accepts overpass snapshot when contour row is missing', async (t) => {
  const { app, savedEdits } = createRouteApp({
    currentContour: null,
    latestSnapshot: {
      osm_type: 'way',
      osm_id: 777,
      source_osm_updated_at: new Date('2026-03-20T00:00:00Z').toString()
    }
  });
  const server = await startServer(app);
  t.after(async () => stopServer(server));

  const port = (() => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server is not listening');
    return address.port;
  })();

  const sourceGeometryJson = JSON.stringify({
    type: 'Polygon',
    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
  });
  const sourceTagsJson = JSON.stringify({
    building: 'yes',
    name: 'Overpass house'
  });

  const response = await fetch(`http://127.0.0.1:${port}/api/building-info`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      osmType: 'way',
      osmId: 777,
      name: 'Overpass house',
      editedFields: ['name'],
      sourceGeometryJson,
      sourceTagsJson
    })
  });

  assert.equal(response.status, 200);
  assert.equal(savedEdits.length, 1);
  assert.equal(savedEdits[0]?.source_geometry_json, sourceGeometryJson);
  assert.equal(savedEdits[0]?.source_tags_json, sourceTagsJson);
  assert.equal(savedEdits[0]?.source_osm_updated_at, '2026-03-20T00:00:00Z');
});

test('building-info save normalizes source timestamp from contour Date values', async (t) => {
  const contourUpdatedAt = new Date('2026-03-25T00:00:00Z');
  const { app, savedEdits } = createRouteApp({
    currentContour: {
      geometry_json: JSON.stringify({
        type: 'Polygon',
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
      }),
      tags_json: JSON.stringify({ building: 'yes' }),
      updated_at: contourUpdatedAt
    }
  });
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
      osmId: 808,
      name: 'Contour house',
      editedFields: ['name']
    })
  });

  assert.equal(response.status, 200);
  assert.equal(savedEdits.length, 1);
  assert.equal(savedEdits[0]?.source_osm_updated_at, '2026-03-25T00:00:00Z');
});

test('building route falls back to the latest stored snapshot when contour row is missing', async (t) => {
  const snapshotGeometry = JSON.stringify({
    type: 'Polygon',
    coordinates: [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]]
  });
  const snapshotTags = JSON.stringify({
    building: 'yes',
    name: 'Snapshot house'
  });
  const { app } = createRouteApp({
    currentContour: null,
    latestSnapshot: {
      osm_type: 'way',
      osm_id: 909,
      source_geometry_json: snapshotGeometry,
      source_tags_json: snapshotTags,
      source_osm_updated_at: '2026-03-20T00:00:00Z',
      updated_at: '2026-03-21T00:00:00Z'
    }
  });
  const server = await startServer(app);
  t.after(async () => stopServer(server));

  const port = (() => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server is not listening');
    return address.port;
  })();

  const response = await fetch(`http://127.0.0.1:${port}/api/building/way/909`);
  assert.equal(response.status, 200);
  const feature = await response.json();
  assert.equal(feature?.id, 'way/909');
  assert.equal(feature?.geometry?.type, 'Polygon');
  assert.equal(feature?.properties?.name, 'Snapshot house');
  assert.equal(feature?.properties?.source_tags?.name, 'Snapshot house');
  assert.equal(feature?.properties?.source_osm_updated_at, '2026-03-20T00:00:00Z');
});
