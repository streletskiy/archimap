const { createHmac, timingSafeEqual } = require('node:crypto');

function workerToken(env = process.env) {
  if (env.SYNC_WORKER_TOKEN) return env.SYNC_WORKER_TOKEN;
  if (!env.SESSION_SECRET) throw new Error('Sync worker authentication requires SESSION_SECRET');
  return createHmac('sha256', env.SESSION_SECRET).update('archimap-sync-worker-v1').digest('hex');
}

function workerAuthorized(header, token) {
  const actual = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createSyncWorkerClient(env) {
  const base = String(env.SYNC_WORKER_URL).replace(/\/$/, '');
  const token = workerToken(env);
  let state = { running: false, queued: 0, oldestQueuedSeconds: 0 };
  async function call(action, body = {}) {
    const response = await fetch(`${base}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Sync worker unavailable');
    if (data.state) state = data.state;
    return data.result;
  }
  return {
    initAutoSync: () => call('status'),
    requestRegionSync: (regionId, options = {}) => call('request', { regionId, options }),
    requestRegionSyncCancel: (regionId) => call('cancel', { regionId }),
    reloadSchedules: () => call('reload'),
    getMetrics: async () => { await call('status'); return state; },
    isSyncInProgress: () => state.running,
    stop() {}
  };
}

module.exports = { createSyncWorkerClient, workerToken, workerAuthorized };
