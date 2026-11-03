const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildImportSignature,
  readActiveRegionSourceState,
  acquireRegionSourceLock,
  _test_
} = require('../../scripts/region-sync/source-state');
const {
  normalizeSourceSnapshotForInsert,
  recordPostgresRegionSourceSnapshot
} = require('../../scripts/region-sync/import-applier');

test('import signature follows import semantics but ignores checkout line endings and tile code', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-import-signature-'));
  try {
    for (const file of _test_.IMPORT_SOURCE_FILES) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.writeFileSync(path.join(directory, file), 'import contract\n');
    }
    const initial = buildImportSignature(directory);
    assert.match(initial, /^[a-f0-9]{64}$/);
    for (const file of _test_.IMPORT_SOURCE_FILES) fs.writeFileSync(path.join(directory, file), 'import contract\r\n');
    assert.equal(buildImportSignature(directory), initial);
    fs.writeFileSync(path.join(directory, 'scripts/region-sync/pmtiles-builder.ts'), 'unrelated tile change');
    assert.equal(buildImportSignature(directory), initial);
    fs.appendFileSync(path.join(directory, _test_.IMPORT_SOURCE_FILES[0]), 'new building selection');
    assert.notEqual(buildImportSignature(directory), initial);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('active source mapping preserves exact validators and prioritizes the applied replication cut', async () => {
  let closed = false;
  class FakeClient {
    async connect() {}
    async end() {
      closed = true;
    }
    async query(sql, params) {
      assert.deepEqual(params, [17]);
      assert.match(sql, /is_active = 1/);
      return {
        rows: [
          {
            id: '5',
            region_id: '17',
            sha256: 'a'.repeat(64),
            size_bytes: '123',
            source_mtime: new Date('2026-01-01T00:00:00Z'),
            replication_timestamp: new Date('2026-01-02T00:00:00Z'),
            source_etag: 'W/"exact-validator"',
            source_last_modified: 'Thu, 01 Jan 2026 00:00:00 GMT',
            local_path: '/cache/immutable.pbf',
            download_url: 'https://example.test/region.pbf',
            import_signature: 'signature',
            replication_sequence: '1234',
            imported_feature_count: '42'
          }
        ]
      };
    }
  }
  const result = await readActiveRegionSourceState('unused', 17, { ClientRef: FakeClient });
  assert.equal(result.sourceMtime, '2026-01-02T00:00:00.000Z');
  assert.equal(result.sourceEtag, 'W/"exact-validator"');
  assert.equal(result.replicationSequence, 1234);
  assert.equal(result.importedFeatureCount, 42);
  assert.equal(result.persistentSource, true);
  assert.equal(closed, true);
});

test('source lock is held until explicit release and closes on acquisition failure', async () => {
  const operations = [];
  class FakeClient {
    async connect() {
      operations.push('connect');
    }
    async end() {
      operations.push('end');
    }
    async query(sql, params) {
      operations.push(sql.includes('unlock') ? 'unlock' : 'lock');
      assert.deepEqual(params, ['archimap:region-source:7']);
    }
  }
  const release = await acquireRegionSourceLock('unused', 7, { ClientRef: FakeClient });
  assert.deepEqual(operations, ['connect', 'lock']);
  await release();
  await release();
  assert.deepEqual(operations, ['connect', 'lock', 'unlock', 'end']);
  class FailedClient extends FakeClient {
    async query() {
      throw new Error('lock failed');
    }
  }
  await assert.rejects(acquireRegionSourceLock('unused', 7, { ClientRef: FailedClient }), /lock failed/);
  assert.equal(operations.at(-1), 'end');
  await assert.rejects(acquireRegionSourceLock('unused', 0, { ClientRef: FakeClient }), /positive region/);
});

test('cancelling a waiting source lock closes its session and cannot acquire the lock later', async () => {
  const controller = new AbortController();
  let started;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let rejectQuery;
  let closes = 0;
  class BlockedClient {
    async connect() {}
    query() {
      started();
      return new Promise((_resolve, reject) => {
        rejectQuery = reject;
      });
    }
    async end() {
      closes++;
      rejectQuery?.(new Error('connection closed'));
    }
  }
  const acquisition = acquireRegionSourceLock('unused', 7, { ClientRef: BlockedClient, signal: controller.signal });
  await waiting;
  controller.abort();
  await assert.rejects(acquisition, { name: 'AbortError' });
  assert.equal(closes, 1);
  await assert.rejects(acquireRegionSourceLock('unused', 7, { ClientRef: BlockedClient, signal: controller.signal }), {
    name: 'AbortError'
  });
  assert.equal(closes, 1, 'already cancelled calls never open a session');
});

test('persistent source validation rejects incomplete state and records its pointer only in the caller transaction', async () => {
  const sourceSnapshot = {
    persistentSource: true,
    sha256: 'a'.repeat(64),
    sizeBytes: 123,
    localPath: '/cache/source.pbf',
    downloadUrl: 'https://example.test/source.pbf',
    importSignature: 'test',
    sourceMtime: '2026-01-01T00:00:00Z',
    replicationTimestamp: '2026-01-02T00:00:00Z',
    replicationSequence: 12,
    sourceEtag: '"exact"',
    sourceLastModified: 'Thu, 01 Jan 2026 00:00:00 GMT'
  };
  const normalized = normalizeSourceSnapshotForInsert(sourceSnapshot);
  assert.equal(normalized.sourceMtime, '2026-01-02T00:00:00.000Z');
  assert.throws(() => normalizeSourceSnapshotForInsert({ ...sourceSnapshot, sha256: '' }), /complete fingerprint/);
  assert.throws(() => normalizeSourceSnapshotForInsert({ ...sourceSnapshot, replicationSequence: -1 }), /sequence/);
  assert.throws(
    () => normalizeSourceSnapshotForInsert({ ...sourceSnapshot, replicationTimestamp: 'invalid' }),
    /timestamp/
  );
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 9 }] };
    }
  };
  assert.equal(
    await recordPostgresRegionSourceSnapshot(client, {
      region: { id: 7 },
      sourceSnapshot,
      importedFeatureCount: 3,
      pmtilesBytes: null
    }),
    9
  );
  assert.equal(calls.length, 2);
  assert.equal(
    calls.some((call) => /BEGIN|COMMIT/.test(call.sql)),
    false
  );
  assert.equal(calls[1].params[5], '2026-01-02T00:00:00.000Z');
  assert.equal(calls[1].params[10], '"exact"');
  await assert.rejects(
    recordPostgresRegionSourceSnapshot(
      {
        query: async () => {
          throw new Error('storage failed');
        }
      },
      { region: { id: 7 }, sourceSnapshot, importedFeatureCount: 3, pmtilesBytes: null }
    ),
    /storage failed/
  );
});
