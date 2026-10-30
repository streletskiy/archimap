const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadinessProbe } = require('../../src/lib/server/infra/readiness.infra');
const { createDataSettingsContext } = require('../../src/lib/server/services/data-settings/shared');
const { initObservabilityInfra } = require('../../src/lib/server/infra/observability.infra');
const { workerToken, workerAuthorized } = require('../../src/lib/server/infra/sync-worker-client.infra');
const { stageCreatedAt } = require('../../scripts/postgres-maintenance');

test('readiness recovers after dependency failure and coalesces concurrent checks', async () => {
  let healthy = false, calls = 0;
  const probe = createReadinessProbe(async () => { calls++; await Promise.resolve(); if (!healthy) throw new Error('offline'); return true; }, { ttlMs: 0 });
  assert.deepEqual(await Promise.all([probe(), probe()]), [false, false]);
  assert.equal(calls, 1);
  healthy = true;
  assert.equal(await probe(), true);
  assert.equal(calls, 2);
});

test('failed sync after an earlier success backs off and opens circuit after eight failures', () => {
  const context = createDataSettingsContext({ db: { provider: 'postgres', prepare() {}, transaction() {} } });
  const now = new Date('2026-10-30T13:00:00Z');
  const region = { id: 2, enabled: true, autoSyncEnabled: true, autoSyncIntervalHours: 24,
    lastSuccessfulSyncAt: '2026-10-27T13:00:00Z', lastSyncStatus: 'failed', lastSyncFinishedAt: now.toISOString(), syncFailureCount: 1 };
  const first = Date.parse(context.computeNextSyncAt(region, now));
  const second = Date.parse(context.computeNextSyncAt({ ...region, syncFailureCount: 2 }, now));
  assert.ok(first > now.getTime()); assert.ok(second > first);
  assert.equal(context.computeNextSyncAt({ ...region, syncFailureCount: 8 }, now), null);
  assert.ok(context.computeNextSyncAt({ ...region, lastSyncStatus: 'idle', syncFailureCount: 0 }, now));
});

test('metrics accepts standard bearer token and readiness awaits live probes', async () => {
  const routes = {};
  const stop = initObservabilityInfra({ use() {}, get(path, handler) { routes[path] = handler; } }, {
    getMetricsToken: async () => 'test-only-token',
    getReadinessChecks: async () => ({ dbReady: false, sessionStoreReady: true })
  });
  const response = () => ({ code: 200, payload: null, status(code) { this.code = code; return this; },
    json(value) { this.payload = value; return this; }, type() { return this; }, send(value) { this.payload = value; return this; } });
  try {
    const good = response(); await routes['/metrics']({ get: () => 'Bearer test-only-token' }, good);
    assert.equal(good.code, 200); assert.match(good.payload, /archimap_event_loop_delay_p99_seconds/);
    const bad = response(); await routes['/metrics']({ get: () => 'Bearer incorrect' }, bad); assert.equal(bad.code, 401);
    const ready = response(); await routes['/readyz']({}, ready); assert.equal(ready.code, 503); assert.equal(ready.payload.ok, false);
  } finally { stop(); }
});

test('worker authentication is scoped and maintenance accepts only generated stage schema names', () => {
  const token = workerToken({ SESSION_SECRET: 'test-session-only' });
  assert.equal(workerAuthorized(`Bearer ${token}`, token), true);
  assert.equal(workerAuthorized('Bearer test-session-only', token), false);
  assert.equal(workerAuthorized('', token), false);
  assert.equal(stageCreatedAt('public'), null);
  assert.equal(stageCreatedAt('region_sync_stage_r1_bad;DROP'), null);
  assert.equal(stageCreatedAt('region_sync_stage_r139_mr09v44k50jyu'), Date.parse('2026-06-30T06:35:01.412Z'));
});
