const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:net');
const { workerToken } = require('../../src/lib/server/infra/sync-worker-client.infra');

test('isolated sync worker serves readiness and authenticates its internal API', { skip: !process.env.PERF_DATABASE_URL, timeout: 45000 }, async () => {
  const admin = new Client({ connectionString: process.env.PERF_DATABASE_URL });
  const databaseName = `archimap_worker_${process.pid}_${Date.now()}`;
  const url = new URL(process.env.PERF_DATABASE_URL); url.pathname = `/${databaseName}`;
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  await admin.connect();
  let child;
  let closed;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const env = { ...process.env, DATABASE_URL: url.toString(), DB_PROVIDER: 'postgres',
      SYNC_WORKER_PORT: String(port), SYNC_WORKER_URL: '', SYNC_WORKER_TOKEN: '',
      SESSION_SECRET: 'isolated-worker-test-secret', NODE_ENV: 'test', LOG_LEVEL: 'error',
      AUTO_SYNC_ENABLED: 'false', AUTO_SYNC_ON_START: 'false', ADMIN_REGIONS_PMTILES_ON_START: 'never' };
    child = spawn(process.execPath, ['--import', 'tsx', 'scripts/sync-worker.ts'], { env, stdio: 'ignore' });
    closed = once(child, 'close');
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* startup */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(ready, 'Worker did not become ready');
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/status`, { method: 'POST' })).status, 401);
    const authorized = { method: 'POST', headers: { Authorization: `Bearer ${workerToken(env)}`, 'Content-Type': 'application/json' }, body: '{}' };
    const response = await fetch(`${base}/status`, authorized);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.state.running, 'boolean');
    assert.equal(body.state.queued, 0);
    assert.equal((await fetch(`${base}/request`, { ...authorized, body: '{"regionId":-1}' })).status, 400);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (closed) await closed;
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
});
