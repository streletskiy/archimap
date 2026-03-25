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
