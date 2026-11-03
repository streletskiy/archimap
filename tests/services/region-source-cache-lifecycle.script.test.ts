const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanupDeletedRegionSourceCaches } = require('../../scripts/region-sync/source-cache-lifecycle');

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-source-lifecycle-'));
  const live = new Set([30]);
  const calls = [];
  const file = id => path.join(dataDir, 'source-cache', `r${id}`, `${'a'.repeat(64)}.osm.pbf`);
  for (const id of [10, 11, 12, 30]) {
    fs.mkdirSync(path.dirname(file(id)), { recursive: true });
    fs.writeFileSync(file(id), `fixture source ${id}`);
  }
  class FakeClient {
    async connect() { calls.push('connect'); }
    async query(sql, params) {
      if (sql.startsWith('SELECT id')) return { rows: [...live].map(id => ({ id })) };
      assert.match(sql, /SELECT EXISTS/);
      calls.push(`exists:${params[0]}`);
      return { rows: [{ present: live.has(params[0]) }] };
    }
    async end() { calls.push('end'); }
  }
  const options: LooseRecord = { databaseUrl: 'fixture', dataDir, ClientRef: FakeClient,
    acquireLock: async (_url, id) => { calls.push(`lock:${id}`); return async () => { calls.push(`unlock:${id}`); }; },
    readSourceState: async (_url, id, options) => {
      assert.equal(options.synchronizeImport, true);
      calls.push(`read:${id}`);
      return null;
    } };
  return { dataDir, file, live, calls, options, close: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('deleted parent and cascade children lose only owned cache files, while live regions are not locked', async () => {
  const f = fixture();
  try {
    const note = path.join(path.dirname(f.file(12)), 'user-note.txt'); fs.writeFileSync(note, 'keep');
    const result = await cleanupDeletedRegionSourceCaches(f.options);
    assert.equal(result.removedFiles, 3);
    assert.equal(result.removedRegions, 3);
    assert.deepEqual(result.failures, []);
    for (const id of [10, 11, 12]) {
      assert.equal(fs.existsSync(f.file(id)), false);
      assert.ok(f.calls.indexOf(`lock:${id}`) < f.calls.indexOf(`read:${id}`));
      assert.ok(f.calls.indexOf(`read:${id}`) < f.calls.indexOf(`exists:${id}`));
      assert.ok(f.calls.includes(`unlock:${id}`));
    }
    assert.equal(fs.existsSync(f.file(30)), true);
    assert.equal(f.calls.includes('lock:30'), false);
    assert.equal(fs.existsSync(note), true);
  } finally { f.close(); }
});

test('a region reappearing under lock, an active snapshot or a failed authoritative read prevents removal', async () => {
  const f = fixture();
  try {
    f.options.readSourceState = async (_url, id, options) => {
      assert.equal(options.synchronizeImport, true);
      if (id === 10) { f.live.add(id); return null; }
      if (id === 11) return { localPath: f.file(id) };
      throw new Error('source state unavailable');
    };
    const result = await cleanupDeletedRegionSourceCaches(f.options);
    assert.equal(result.removedFiles, 0);
    assert.deepEqual(result.failures, [{ regionId: 12, error: 'source state unavailable' }]);
    for (const id of [10, 11, 12, 30]) assert.equal(fs.existsSync(f.file(id)), true);
    for (const id of [10, 11, 12]) assert.ok(f.calls.includes(`unlock:${id}`));
    assert.equal(f.calls.at(-1), 'end');
  } finally { f.close(); }
});
