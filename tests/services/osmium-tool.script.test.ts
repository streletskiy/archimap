const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  applyReplicationChanges,
  commandForOsmium,
  readPbfReplicationMetadata,
  toOsmiumContainerPath
} = require('../../scripts/region-sync/osmium-tool');

const state = {
  baseUrl: 'https://download.openstreetmap.fr/replication/example/minute',
  sequence: 42,
  timestamp: '2026-11-03T00:01:02.000Z'
};
function metadataOutput(value = state) {
  return JSON.stringify({
    header: {
      option: {
        osmosis_replication_base_url: value.baseUrl,
        osmosis_replication_sequence_number: String(value.sequence),
        osmosis_replication_timestamp: value.timestamp
      }
    }
  });
}
function childProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

test('native Osmium applies caller order, fsyncs and verifies the output cursor', async () => {
  const calls = [];
  const spawnRef = (exe, args, options) => {
    calls.push({ exe, args, options });
    const child = childProcess();
    queueMicrotask(() => {
      if (args[0] === 'fileinfo') child.stdout.write(metadataOutput());
      child.emit('close', 0);
    });
    return child;
  };
  assert.deepEqual(
    await applyReplicationChanges({
      basePath: '/app/data/base.pbf',
      changePaths: ['/app/data/999.osc.gz', '/app/data/000.osc.gz'],
      targetPath: '/app/data/next.pbf',
      state,
      env: { OSMIUM_BIN: '/usr/local/bin/osmium' },
      spawnRef
    }),
    state
  );
  assert.equal(calls[0].exe, '/usr/local/bin/osmium');
  assert.deepEqual(calls[0].args.slice(-3), ['/app/data/base.pbf', '/app/data/999.osc.gz', '/app/data/000.osc.gz']);
  assert.ok(calls[0].args.includes('--fsync'));
  assert.ok(!calls[0].args.includes('--overwrite'));
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[1].args[0], 'fileinfo');
});

test('PBF without an exact replication sequence cannot initialize a cursor', async () => {
  const spawnRef = () => {
    const child = childProcess();
    queueMicrotask(() => {
      child.stdout.write('{"header":{"option":{}}}');
      child.emit('close', 0);
    });
    return child;
  };
  await assert.rejects(readPbfReplicationMetadata('base.pbf', { spawnRef, env: {} }), /metadata is missing/);
  assert.equal(await readPbfReplicationMetadata('base.pbf', { spawnRef, env: {}, allowMissing: true }), null);
});

test('allowMissing does not hide a malformed file or failed Osmium command', async () => {
  const spawnRef = () => {
    const child = childProcess();
    queueMicrotask(() => {
      child.stderr.write('PBF error: invalid BlobHeader');
      child.emit('close', 1);
    });
    return child;
  };
  await assert.rejects(
    readPbfReplicationMetadata('base.pbf', { spawnRef, env: {}, allowMissing: true }),
    /invalid BlobHeader/
  );
});

test('explicit container maps only shared paths and passes file names as separate arguments', () => {
  const env = {
    OSMIUM_CONTAINER: 'stand-tools',
    OSMIUM_HOST_DATA_ROOT: 'E:\\stand data',
    OSMIUM_CONTAINER_DATA_ROOT: '/app/data'
  };
  const input = 'E:\\stand data\\nested\\a $file.pbf';
  assert.equal(toOsmiumContainerPath(input, env), '/app/data/nested/a $file.pbf');
  assert.throws(() => toOsmiumContainerPath('E:\\outside\\base.pbf', env), /within/);
  const command = commandForOsmium(['fileinfo', '--json', input], [input], env);
  assert.equal(command.executable, 'docker');
  assert.equal(command.args.at(-1), '/app/data/nested/a $file.pbf');
  assert.ok(!command.args[4].includes('$file'));
});

test('native cancellation waits for Osmium exit before rejecting', async () => {
  const controller = new AbortController();
  const child = childProcess();
  const signals = [];
  child.kill = (signal) => signals.push(signal);
  let rejected = false;
  const operation = readPbfReplicationMetadata('base.pbf', {
    signal: controller.signal,
    env: {},
    spawnRef: () => child
  });
  operation.catch(() => {
    rejected = true;
  });
  controller.abort();
  await Promise.resolve();
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(rejected, false);
  child.emit('close', null);
  await assert.rejects(operation, { name: 'AbortError' });
});

test('container cancellation terminates the remote PID before workspace cleanup', async () => {
  const controller = new AbortController();
  const child = childProcess();
  const calls = [];
  const operation = readPbfReplicationMetadata('/app/data/base.pbf', {
    signal: controller.signal,
    env: { OSMIUM_CONTAINER: 'stand-tools' },
    spawnRef: (exe, args) => {
      calls.push([exe, ...args]);
      return calls.length === 1 ? child : childProcess();
    }
  });
  controller.abort();
  child.stderr.write('__ARCHIMAP_OSMIUM_PID__=');
  child.stderr.write('321\n');
  assert.deepEqual(calls[1], ['docker', 'exec', 'stand-tools', 'kill', '-TERM', '321']);
  child.emit('close', 143);
  await assert.rejects(operation, { name: 'AbortError' });
});

test('argument batching preserves every diff in order and removes consumed intermediate PBFs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osmium-batches-'));
  const base = path.join(dir, 'base.pbf'),
    target = path.join(dir, 'target.pbf');
  const changes = Array.from({ length: 6 }, (_, i) => path.join(dir, `${i}-${'x'.repeat(800)}.osc.gz`));
  const budget = process.platform === 'win32' ? 3500 : 1800;
  const calls = [];
  fs.writeFileSync(base, 'original');
  try {
    await applyReplicationChanges({
      basePath: base,
      changePaths: changes,
      targetPath: target,
      state,
      env: {},
      _argumentBudgetBytes: budget,
      spawnRef: (exe, args) => {
        const child = childProcess();
        queueMicrotask(() => {
          if (args[0] === 'apply-changes') {
            const at = args.indexOf('--output');
            const output = args[at + 1],
              input = args[at + 2];
            assert.ok(fs.existsSync(input));
            // There is at most one previously completed intermediate on disk.
            assert.ok(fs.readdirSync(dir).filter((name) => name.startsWith('.replication-')).length <= 1);
            const encoded = [exe, ...args].reduce(
              (n, arg) => n + Buffer.byteLength(arg) * (process.platform === 'win32' ? 2 : 1) + 4,
              0
            );
            assert.ok(encoded <= budget);
            calls.push({
              input,
              output,
              changes: args.slice(at + 3),
              stamped: args.some((arg) => arg.startsWith('--output-header='))
            });
            fs.writeFileSync(output, 'next');
          } else child.stdout.write(metadataOutput());
          child.emit('close', 0);
        });
        return child;
      }
    });
    assert.ok(calls.length > 1);
    assert.deepEqual(
      calls.flatMap((call) => call.changes),
      changes
    );
    assert.equal(calls[0].input, base);
    assert.equal(calls.at(-1).output, target);
    assert.deepEqual(
      calls.map((call) => call.stamped),
      calls.map((_, i) => i === calls.length - 1)
    );
    for (let i = 1; i < calls.length; i++) assert.equal(calls[i].input, calls[i - 1].output);
    assert.equal(fs.readFileSync(base, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['base.pbf', 'target.pbf']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const mode of ['failure', 'abort'])
  test(`argument batching cleans partial/intermediate PBFs on ${mode}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osmium-batches-'));
    const base = path.join(dir, 'base.pbf'),
      target = path.join(dir, 'target.pbf');
    const controller = new AbortController();
    const changes = Array.from({ length: 4 }, (_, i) => path.join(dir, `${i}-${'x'.repeat(800)}.osc.gz`));
    let calls = 0;
    fs.writeFileSync(base, 'original');
    try {
      await assert.rejects(
        applyReplicationChanges({
          basePath: base,
          changePaths: changes,
          targetPath: target,
          state,
          env: {},
          signal: controller.signal,
          _argumentBudgetBytes: process.platform === 'win32' ? 3500 : 1800,
          spawnRef: (_exe, args) => {
            const child = childProcess();
            child.kill = () => {
              queueMicrotask(() => child.emit('close', null));
              return true;
            };
            queueMicrotask(() => {
              calls++;
              fs.writeFileSync(args[args.indexOf('--output') + 1], 'partial');
              if (calls === 2) {
                if (mode === 'abort') controller.abort();
                else {
                  child.stderr.write('injected batch failure');
                  child.emit('close', 1);
                }
              } else child.emit('close', 0);
            });
            return child;
          }
        }),
        mode === 'abort' ? { name: 'AbortError' } : /injected batch failure/
      );
      assert.equal(calls, 2);
      assert.deepEqual(fs.readdirSync(dir), ['base.pbf']);
      assert.equal(fs.readFileSync(base, 'utf8'), 'original');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
