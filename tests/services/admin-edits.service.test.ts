const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdminEditsService } = require('../../src/lib/server/services/admin/admin-edits.service');
const { normalizeUserEditStatus } = require('../../src/lib/server/services/edits.service');

function createBlockedAdminEditsService(syncStatus) {
  const details = {
    editId: 1,
    osmType: 'way',
    osmId: 2001,
    updatedBy: 'user@example.com',
    updatedAt: '2026-03-25T00:00:00Z',
    createdAt: '2026-03-24T00:00:00Z',
    status: 'pending',
    syncStatus,
    changes: [{ field: 'name' }]
  };

  return createAdminEditsService({
    db: {
      prepare() {
        throw new Error('DB should not be used when sync status is blocked');
      },
      transaction() {
        throw new Error('DB transaction should not be used when sync status is blocked');
      }
    },
    getUserEditsList: async () => [],
    getUserEditDetailsById: async () => ({ ...details }),
    normalizeUserEditStatus,
    sanitizeFieldText: (value) => (value == null ? null : String(value)),
    sanitizeYearBuilt: () => null,
    sanitizeLevels: () => null,
    getMergedInfoRow: async () => {
      throw new Error('Merged info lookup should not be used when sync status is blocked');
    },
    getOsmContourRow: async () => {
      throw new Error('Contour lookup should not be used when sync status is blocked');
    },
    reassignUserEdit: async () => {
      throw new Error('Reassign mutation should not be used when sync status is blocked');
    },
    deleteUserEdit: async () => {
      throw new Error('Delete mutation should not be used when sync status is blocked');
    },
    enqueueSearchIndexRefresh: () => {},
    refreshDesignRefSuggestionsCache: () => {},
    ARCHI_FIELD_SET: new Set([
      'name',
      'style',
      'design',
      'design_ref',
      'design_year',
      'material',
      'colour',
      'levels',
      'year_built',
      'architect',
      'address',
      'archimap_description'
    ])
  });
}

function assertBlockedSyncError(error, expectedCode, expectedMessagePattern) {
  assert.equal(error.status, 409);
  assert.equal(error.code, expectedCode);
  assert.match(error.message, expectedMessagePattern);
  return true;
}

function createDbStub({
  editSourceRow = {},
  statusRow = { status: 'accepted' }
} = {}) {
  return {
    provider: 'sqlite',
    transaction(fn) {
      return fn;
    },
    prepare(sql) {
      const text = String(sql || '');

      if (text.includes('SELECT name, style, design, design_ref, design_year, material, material_concrete, colour, levels, year_built, architect, address, archimap_description')) {
        return {
          get() {
            return editSourceRow;
          },
          run() {
            return { changes: 0 };
          },
          all() {
            return [];
          }
        };
      }

      if (text.includes('SELECT status FROM user_edits.building_user_edits WHERE id = ?')) {
        return {
          get() {
            return statusRow;
          },
          run() {
            return { changes: 0 };
          },
          all() {
            return [];
          }
        };
      }

      return {
        get() {
          return null;
        },
        run() {
          return { changes: 1, lastInsertRowid: 1 };
        },
        all() {
          return [];
        }
      };
    }
  };
}

function createRefreshTrackingService({
  status = 'pending',
  changes = [{ field: 'style' }],
  editSourceRow = {},
  currentMergedRow: currentMergedRowInput = {},
  currentContour: currentContourInput = {},
  deleteResult: deleteResultInput = {},
  reassignResult: reassignResultInput = {},
  refreshPromise = Promise.resolve()
} = {}) {
  const refreshCalls = [];
  const searchRefreshCalls = [];
  const currentMergedRow = {
    osm_type: 'way',
    osm_id: 2001,
    style: 'old-style',
    design_ref: null,
    updated_at: '2026-03-23T00:00:00Z',
    ...currentMergedRowInput
  };
  const currentContour = {
    tags_json: JSON.stringify({ building: 'yes' }),
    updated_at: '2026-03-22T00:00:00Z',
    ...currentContourInput
  };
  const service = createAdminEditsService({
    db: createDbStub({ editSourceRow }),
    getUserEditsList: async () => [],
    getUserEditDetailsById: async () => ({
      editId: 1,
      osmType: 'way',
      osmId: 2001,
      updatedBy: 'user@example.com',
      updatedAt: '2026-03-25T00:00:00Z',
      createdAt: '2026-03-24T00:00:00Z',
      status,
      syncStatus: 'unsynced',
      changes
    }),
    normalizeUserEditStatus,
    sanitizeFieldText: (value) => (value == null ? null : String(value).trim()),
    sanitizeYearBuilt: (value) => (value == null || String(value).trim() === '' ? null : Number(value)),
    sanitizeLevels: (value) => (value == null || String(value).trim() === '' ? null : Number(value)),
    getMergedInfoRow: async () => currentMergedRow,
    getOsmContourRow: async () => currentContour,
    reassignUserEdit: async (_editId, target) => ({
      editId: 1,
      osmType: target?.osmType ?? 'way',
      osmId: target?.osmId ?? 2001,
      status,
      ...reassignResultInput
    }),
    deleteUserEdit: async () => ({
      editId: 1,
      osmType: 'way',
      osmId: 2001,
      status,
      deletedMergedLocal: false,
      ...deleteResultInput
    }),
    enqueueSearchIndexRefresh: (osmType, osmId) => {
      searchRefreshCalls.push(`${osmType}/${osmId}`);
    },
    refreshDesignRefSuggestionsCache: (reason) => {
      refreshCalls.push(reason);
      return refreshPromise;
    },
    ARCHI_FIELD_SET: new Set([
      'name',
      'style',
      'design',
      'design_ref',
      'design_year',
      'material',
      'colour',
      'levels',
      'year_built',
      'architect',
      'address',
      'archimap_description'
    ])
  });

  return { service, refreshCalls, searchRefreshCalls };
}

async function withTimeout(promise, timeoutMs = 1000) {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

test('admin edit operations reject synced, cleaned, and syncing rows before mutating', async () => {
  const cases = [
    {
      syncStatus: 'synced',
      expectedCode: 'EDIT_SYNC_LOCKED',
      expectedMessage: /already been synchronized/i
    },
    {
      syncStatus: 'cleaned',
      expectedCode: 'EDIT_SYNC_LOCKED',
      expectedMessage: /already been synchronized/i
    },
    {
      syncStatus: 'syncing',
      expectedCode: 'EDIT_SYNC_IN_PROGRESS',
      expectedMessage: /currently being synchronized/i
    }
  ];

  for (const { syncStatus, expectedCode, expectedMessage } of cases) {
    const service = createBlockedAdminEditsService(syncStatus);

    await assert.rejects(
      () => service.rejectBuildingEdit(1, { reviewer: 'admin@example.com' }),
      (error) => assertBlockedSyncError(error, expectedCode, expectedMessage)
    );

    await assert.rejects(
      () => service.reassignBuildingEdit(1, { target: { osmType: 'way', osmId: 3001 }, actor: 'admin@example.com' }),
      (error) => assertBlockedSyncError(error, expectedCode, expectedMessage)
    );

    await assert.rejects(
      () => service.deleteBuildingEdit(1),
      (error) => assertBlockedSyncError(error, expectedCode, expectedMessage)
    );

    await assert.rejects(
      () => service.mergeBuildingEdit(1, {
        fields: ['name'],
        values: { name: 'New name' },
        reviewer: 'admin@example.com'
      }),
      (error) => assertBlockedSyncError(error, expectedCode, expectedMessage)
    );
  }
});

test('admin merge refreshes search index for style changes without waiting for design-ref cache', async () => {
  const { service, refreshCalls, searchRefreshCalls } = createRefreshTrackingService({
    changes: [{ field: 'style' }],
    editSourceRow: {
      style: 'omani'
    },
    currentMergedRow: {
      osm_type: 'way',
      osm_id: 2001,
      style: 'old-style',
      updated_at: '2026-03-23T00:00:00Z'
    }
  });

  const result = await withTimeout(service.mergeBuildingEdit(1, {
    fields: ['style'],
    values: { style: 'omani' },
    reviewer: 'admin@example.com'
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(refreshCalls, []);
  assert.deepEqual(searchRefreshCalls, ['way/2001']);
});

test('admin merge skips search index refresh for material-only edits', async () => {
  const { service, refreshCalls, searchRefreshCalls } = createRefreshTrackingService({
    changes: [{ field: 'material' }],
    editSourceRow: {
      material: 'brick'
    },
    currentMergedRow: {
      osm_type: 'way',
      osm_id: 2001,
      material: 'stone',
      updated_at: '2026-03-23T00:00:00Z'
    }
  });

  const result = await withTimeout(service.mergeBuildingEdit(1, {
    fields: ['material'],
    values: { material: 'brick' },
    reviewer: 'admin@example.com'
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(refreshCalls, []);
  assert.deepEqual(searchRefreshCalls, []);
});

test('admin merge refreshes design-ref suggestions without blocking when design-ref changes', async () => {
  const refreshPromise = new Promise<void>(() => {});
  const { service, refreshCalls, searchRefreshCalls } = createRefreshTrackingService({
    changes: [{ field: 'design_ref' }],
    editSourceRow: {
      design_ref: '1-464'
    },
    currentMergedRow: {
      osm_type: 'way',
      osm_id: 2001,
      design_ref: '1-335',
      updated_at: '2026-03-23T00:00:00Z'
    },
    refreshPromise
  });

  const result = await withTimeout(service.mergeBuildingEdit(1, {
    fields: ['design_ref'],
    values: { design_ref: '1-464' },
    reviewer: 'admin@example.com'
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(refreshCalls, ['admin-merge']);
  assert.deepEqual(searchRefreshCalls, ['way/2001']);
});

test('admin delete skips search index refresh for material-only accepted edits', async () => {
  const { service, searchRefreshCalls } = createRefreshTrackingService({
    status: 'accepted',
    changes: [{ field: 'material' }],
    deleteResult: {
      editId: 1,
      osmType: 'way',
      osmId: 2001,
      status: 'accepted',
      deletedMergedLocal: true
    }
  });

  const result = await withTimeout(service.deleteBuildingEdit(1));

  assert.equal(result.editId, 1);
  assert.equal(result.status, 'accepted');
  assert.equal(result.deletedMergedLocal, true);
  assert.deepEqual(searchRefreshCalls, []);
});

test('admin delete refreshes search index for accepted name edits', async () => {
  const { service, searchRefreshCalls } = createRefreshTrackingService({
    status: 'accepted',
    changes: [{ field: 'name' }],
    deleteResult: {
      editId: 1,
      osmType: 'way',
      osmId: 2001,
      status: 'accepted',
      deletedMergedLocal: true
    }
  });

  const result = await withTimeout(service.deleteBuildingEdit(1));

  assert.equal(result.editId, 1);
  assert.equal(result.status, 'accepted');
  assert.equal(result.deletedMergedLocal, true);
  assert.deepEqual(searchRefreshCalls, ['way/2001']);
});

test('admin reassign skips search index refresh for pending material-only edits', async () => {
  const { service, searchRefreshCalls } = createRefreshTrackingService({
    status: 'pending',
    changes: [{ field: 'material' }],
    reassignResult: {
      editId: 1,
      osmType: 'way',
      osmId: 2002,
      status: 'pending'
    }
  });

  const result = await withTimeout(service.reassignBuildingEdit(1, {
    target: { osmType: 'way', osmId: 2002 },
    actor: 'admin@example.com'
  }));

  assert.equal(result.osmId, 2002);
  assert.equal(result.status, 'pending');
  assert.deepEqual(searchRefreshCalls, []);
});

test('admin reassign refreshes search index for accepted style edits on both buildings', async () => {
  const { service, searchRefreshCalls } = createRefreshTrackingService({
    status: 'accepted',
    changes: [{ field: 'style' }],
    reassignResult: {
      editId: 1,
      osmType: 'way',
      osmId: 2002,
      status: 'accepted'
    }
  });

  const result = await withTimeout(service.reassignBuildingEdit(1, {
    target: { osmType: 'way', osmId: 2002 },
    actor: 'admin@example.com'
  }));

  assert.equal(result.osmId, 2002);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(searchRefreshCalls, ['way/2001', 'way/2002']);
});
