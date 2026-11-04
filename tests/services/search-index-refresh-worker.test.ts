const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSearchRefreshWorker } = require('../../workers/refresh-search-index.worker');

const settle = () => new Promise((resolve) => setImmediate(resolve));

function createWorkerFixture(options: LooseRecord = {}) {
  const timers = [];
  const clients = [];
  const messages = [];
  const errors = [];
  const targets = [];
  const batches = [];
  const state = { projection_version: 2, index_present: true };
  let runtimeClosed = 0;
  const worker = createSearchRefreshWorker({
    provider: options.provider || 'postgres',
    createRuntime: options.createRuntime || (async () => ({ db: {}, close: async () => { runtimeClosed++; } })),
    createRefreshService: () => ({ refreshSearchIndexForBuilding: async (type, id) => {
      targets.push([type, id]);
      await options.onTarget?.(type, id);
    } }),
    createDurableClient: () => {
      const client: LooseRecord = new EventEmitter();
      client.closed = 0;
      client.connect = async () => {};
      client.query = async () => ({ rows: [{ ...state }] });
      client.end = async () => { client.closed++; };
      clients.push(client);
      return client;
    },
    refreshDurableChanges: async (client, batchOptions) => {
      batches.push({ client, options: batchOptions });
      return options.onBatch ? options.onBatch() : 0;
    },
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, cancelled: false, fired: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => { timer.cancelled = true; },
    sendMessage: (message) => messages.push(message),
    logger: { error: (...args) => errors.push(args) }
  });
  const nextTimer = () => timers.find((timer) => !timer.cancelled && !timer.fired);
  return {
    worker, timers, clients, messages, errors, targets, batches, state, nextTimer,
    get runtimeClosed() { return runtimeClosed; },
    async tick() {
      const timer = nextTimer();
      assert.ok(timer, 'a future durable poll must be scheduled');
      timer.fired = true;
      timer.callback();
      await settle();
      return timer.delay;
    },
    async start() { await worker.start(); await settle(); }
  };
}

test('PostgreSQL keeps polling after an empty or busy slice and finds later changes without IPC', async (t) => {
  let pending = 0;
  const fixture = createWorkerFixture({ onBatch: () => { const count = pending; pending = 0; return count; } });
  t.after(() => fixture.worker.stop());
  await fixture.start();
  assert.deepEqual(fixture.messages, [{ type: 'ready' }, { type: 'drained', processed: 0 }]);
  assert.equal(fixture.nextTimer().delay, 5000);
  assert.deepEqual(fixture.batches[0].options, { maxBatches: 1, waitForLock: false });
  pending = 42;
  await fixture.tick();
  assert.equal(fixture.messages.at(-1).processed, 42);
  assert.equal(fixture.nextTimer().delay, 25);
  await fixture.tick();
  assert.equal(fixture.nextTimer().delay, 5000);
  assert.equal(fixture.clients.length, 1);
  assert.equal(fixture.errors.length, 0);
});

test('durable slices do not overlap and explicit edits run before the next slice', async (t) => {
  let finishBatch;
  const batchWait = new Promise<number>((resolve) => { finishBatch = resolve; });
  const order = [];
  const fixture = createWorkerFixture({
    onBatch: async () => { order.push('batch'); await batchWait; return 5000; },
    onTarget: () => order.push('edit')
  });
  t.after(() => fixture.worker.stop());
  await fixture.start();
  fixture.worker.enqueue({ osmType: 'way', osmId: 1 });
  fixture.worker.enqueue({ osmType: 'way', osmId: 1 });
  await settle();
  assert.equal(fixture.batches.length, 1);
  assert.equal(fixture.targets.length, 0);
  finishBatch(5000);
  await settle();
  assert.deepEqual(order, ['batch', 'edit']);
  assert.deepEqual(fixture.targets, [['way', 1]]);
  assert.deepEqual(fixture.messages.filter((message) => message.type === 'refreshed'), [{ type: 'refreshed', processed: 1 }]);
  await fixture.tick();
  assert.deepEqual(order, ['batch', 'edit', 'batch']);
});

test('failed durable slices reconnect with backoff and recover without a new message', async (t) => {
  let attempts = 0;
  const fixture = createWorkerFixture({ onBatch: () => {
    if (++attempts < 3) throw new Error('temporary database failure');
    return 3;
  } });
  t.after(() => fixture.worker.stop());
  await fixture.start();
  assert.equal(fixture.nextTimer().delay, 1000);
  assert.equal(fixture.clients[0].closed, 1);
  await fixture.tick();
  assert.equal(fixture.nextTimer().delay, 2000);
  await fixture.tick();
  assert.equal(fixture.clients.length, 3);
  assert.equal(fixture.errors.length, 2);
  assert.equal(fixture.messages.at(-1).processed, 3);
  assert.equal(fixture.nextTimer().delay, 25);
});

test('periodic drain waits for the current projection and its search index', async (t) => {
  const fixture = createWorkerFixture();
  t.after(() => fixture.worker.stop());
  fixture.state.projection_version = 1;
  await fixture.start();
  assert.equal(fixture.batches.length, 0);
  fixture.state.projection_version = 2;
  fixture.state.index_present = false;
  await fixture.tick();
  assert.equal(fixture.batches.length, 0);
  fixture.state.index_present = true;
  await fixture.tick();
  assert.equal(fixture.batches.length, 1);
});

test('shutdown cancels polling and waits for the active transaction before closing connections', async () => {
  let finishBatch;
  const fixture = createWorkerFixture({ onBatch: () => new Promise<number>((resolve) => { finishBatch = resolve; }) });
  await fixture.start();
  let stopped = false;
  const stopping = fixture.worker.stop().then(() => { stopped = true; });
  fixture.worker.enqueue({ osmType: 'way', osmId: 1 });
  await settle();
  assert.equal(stopped, false);
  assert.equal(fixture.clients[0].closed, 0);
  finishBatch(1);
  await stopping;
  assert.equal(fixture.clients[0].closed, 1);
  assert.equal(fixture.runtimeClosed, 1);
  assert.equal(fixture.nextTimer(), undefined);
  assert.equal(fixture.targets.length, 0);
  await fixture.worker.stop();
  assert.equal(fixture.runtimeClosed, 1);
});

test('shutdown cancels error retries and an already queued timer cannot restart work', async () => {
  const fixture = createWorkerFixture({ onBatch: () => { throw new Error('offline'); } });
  await fixture.start();
  const retry = fixture.nextTimer();
  await fixture.worker.stop();
  assert.equal(retry.cancelled, true);
  retry.callback();
  await settle();
  assert.equal(fixture.clients.length, 1);
  assert.equal(fixture.batches.length, 1);
});

test('shutdown waits for database initialization without starting a poll or leaking the runtime', async () => {
  let finishStartup;
  let runtimeClosed = 0;
  const fixture = createWorkerFixture({ createRuntime: () => new Promise((resolve) => { finishStartup = resolve; }) });
  const starting = fixture.worker.start();
  let stopped = false;
  const stopping = fixture.worker.stop().then(() => { stopped = true; });
  await settle();
  assert.equal(stopped, false);
  finishStartup({ db: {}, close: async () => { runtimeClosed++; } });
  await Promise.all([starting, stopping]);
  assert.equal(runtimeClosed, 1);
  assert.equal(fixture.messages.length, 0);
  assert.equal(fixture.clients.length, 0);
  assert.equal(fixture.timers.length, 0);
});

test('failed explicit edits do not report a committed refresh', async (t) => {
  const fixture = createWorkerFixture({ provider: 'sqlite', onTarget: () => { throw new Error('write failed'); } });
  t.after(() => fixture.worker.stop());
  fixture.worker.enqueue({ osmType: 'way', osmId: 1 });
  await fixture.start();
  assert.equal(fixture.errors.length, 1);
  assert.equal(fixture.messages.some((message) => message.type === 'refreshed'), false);
});

test('SQLite still refreshes explicit edits without PostgreSQL polling', async (t) => {
  const fixture = createWorkerFixture({ provider: 'sqlite' });
  t.after(() => fixture.worker.stop());
  fixture.worker.enqueue({ osmType: 'way', osmId: 7 });
  fixture.worker.enqueue({ osmType: 'way', osmId: 7 });
  await fixture.start();
  assert.deepEqual(fixture.targets, [['way', 7]]);
  assert.equal(fixture.clients.length, 0);
  assert.equal(fixture.timers.length, 0);
});
