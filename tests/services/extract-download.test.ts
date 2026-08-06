const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { downloadManagedRegionExtract } = require('../../scripts/region-sync/extract-download');

function createChildProcessStub() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    child.emit('close', null, signal);
    return true;
  };
  return child;
}

async function waitFor(condition, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('downloadManagedRegionExtract uses aria2 progress output and records source snapshot', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-download-'));
  const child = createChildProcessStub();
  const spawnCalls = [];
  const stageUpdates = [];
  const pbfPath = path.join(workspace, 'source.osm.pbf');
  const expectedHash = crypto.createHash('sha256').update('hello world').digest('hex');

  try {
    const promise = downloadManagedRegionExtract({
      region: {
        extractSource: 'geofabrik',
        extractId: 'finland'
      },
      workspace,
      regionCatalog: {
        findEntry() {
          return {
            extractSource: 'geofabrik',
            extractId: 'finland',
            downloadUrl: 'https://download.example/finland.osm.pbf'
          };
        }
      },
      fetchImpl: async (input, init: { method?: string } = {}) => {
        assert.equal(String(input), 'https://download.example/finland.osm.pbf');
        assert.equal(String(init.method || 'GET').toUpperCase(), 'HEAD');
        return {
          ok: true,
          headers: {
            get(name) {
              return String(name || '').toLowerCase() === 'last-modified'
                ? 'Mon, 01 Apr 2024 12:00:00 GMT'
                : null;
            }
          }
        };
      },
      spawnSyncRef: (execPath, args, options = {}) => {
        spawnCalls.push({ execPath, args, options, kind: 'probe' });
        return args[0] === '--version' ? { status: 0 } : { status: 0 };
      },
      spawnRef: (execPath, args, options = {}) => {
        spawnCalls.push({ execPath, args, options, kind: 'download' });
        return child;
      },
      log: {
        log() {},
        error() {}
      },
      onStage: async (stage, detail, progress) => {
        stageUpdates.push({ stage, detail, progress });
      }
    });

    await waitFor(() => spawnCalls.some((call) => call.kind === 'download'));
    child.stdout.emit(
      'data',
      Buffer.from('[#1 SIZE:400.0KiB/33.2MiB(1%) CN:1 SPD:115.7KiBs ETA:4m51s]\n')
    );
    fs.writeFileSync(pbfPath, Buffer.from('hello world'));
    child.emit('close', 0, null);

    const result = await promise;

    assert.equal(result.pbfPath, pbfPath);
    assert.equal(result.sourceSnapshot.extractSource, 'geofabrik');
    assert.equal(result.sourceSnapshot.extractId, 'finland');
    assert.equal(result.sourceSnapshot.sourceMtime, 'Mon, 01 Apr 2024 12:00:00 GMT');
    assert.equal(result.sourceSnapshot.sizeBytes, 11);
    assert.equal(result.sourceSnapshot.sha256, expectedHash);
    assert.equal(spawnCalls.some((call) => call.kind === 'probe' && call.args[0] === '--version'), true);

    const downloadCall = spawnCalls.find((call) => call.kind === 'download');
    assert.ok(downloadCall);
    assert.ok(downloadCall.args.includes('--summary-interval=1'));
    assert.ok(downloadCall.args.includes('--split=8'));
    assert.ok(downloadCall.args.includes('--max-connection-per-server=8'));

    assert.ok(stageUpdates.length >= 3);
    assert.equal(stageUpdates[0].stage, 'download');
    assert.match(stageUpdates[0].detail, /fetching geofabrik:finland/);
    assert.equal(stageUpdates[0].progress, 0);

    const aria2Progress = stageUpdates.find((update) => update.progress === 1);
    assert.ok(aria2Progress);
    assert.match(aria2Progress.detail, /aria2 1%/);
    assert.match(aria2Progress.detail, /ETA 4m51s/);

    const finalUpdate = stageUpdates.at(-1);
    assert.equal(finalUpdate.stage, 'download');
    assert.equal(finalUpdate.progress, 100);
    assert.match(finalUpdate.detail, /downloaded geofabrik:finland/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('downloadManagedRegionExtract fails fast when aria2 is unavailable and fallback is disabled', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-download-'));
  let fetchCalled = false;

  try {
    await assert.rejects(
      downloadManagedRegionExtract({
        region: {
          extractSource: 'geofabrik',
          extractId: 'finland'
        },
        workspace,
        regionCatalog: {
          findEntry() {
            return {
              extractSource: 'geofabrik',
              extractId: 'finland',
              downloadUrl: 'https://download.example/finland.osm.pbf'
            };
          }
        },
        fetchImpl: async () => {
          fetchCalled = true;
          throw new Error('fetch should not be called when aria2 is unavailable');
        },
        spawnSyncRef: () => ({ status: 1 }),
        spawnRef: () => {
          throw new Error('spawn should not be called when aria2 is unavailable');
        },
        log: {
          log() {},
          error() {}
        }
      }),
      /aria2c is not available in this runtime/
    );

    assert.equal(fetchCalled, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
