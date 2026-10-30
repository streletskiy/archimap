require('dotenv').config({ quiet: true });
const http = require('node:http');
const { spawn } = require('node:child_process');
const { ServerRuntime, runPostDbStartupTasks } = require('../src/lib/server/boot/server-runtime.boot');
const { workerToken, workerAuthorized } = require('../src/lib/server/infra/sync-worker-client.infra');

async function main() {
  const token = workerToken();
  process.env.RUNTIME_ROLE = 'sync-worker';
  const runtime = new ServerRuntime();
  await runtime.dbRuntimePromise;
  const server = http.createServer(async (req, res) => {
    const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.method === 'GET' && req.url === '/healthz') {
      const ready = await runtime.checkDbReadiness();
      return send(ready ? 200 : 503, { ok: ready });
    }
    if (!workerAuthorized(req.headers.authorization, token)) return send(401, { error: 'Unauthorized' });
    if (req.method !== 'POST' || !['/status', '/request', '/cancel', '/reload'].includes(req.url)) return send(404, { error: 'Not found' });
    try {
      let text = '';
      for await (const chunk of req) { text += chunk.toString(); if (text.length > 4096) { send(413, { error: 'Request too large' }); req.destroy(); return; } }
      const body = text ? JSON.parse(text) : {};
      const regionId = Number(body.regionId);
      if (['/request', '/cancel'].includes(req.url) && (!Number.isSafeInteger(regionId) || regionId <= 0)) return send(400, { error: 'Invalid region id' });
      let result = null;
      if (req.url === '/request') result = await runtime.syncWorkers.requestRegionSync(regionId, {
        triggerReason: 'manual', requestedBy: String(body.options?.requestedBy || 'admin').slice(0, 160),
        skipUpstreamCheck: body.options?.skipUpstreamCheck === true
      });
      if (req.url === '/cancel') result = await runtime.syncWorkers.requestRegionSyncCancel(regionId);
      if (req.url === '/reload') await runtime.syncWorkers.reloadSchedules();
      const row = await runtime.db.prepare(`SELECT COUNT(*) AS queued, MIN(requested_at) AS oldest FROM data_region_sync_runs WHERE status = 'queued'`).get();
      const oldest = Date.parse(row?.oldest || '');
      send(200, { result, state: { running: runtime.syncWorkers.isSyncInProgress(), queued: Number(row?.queued || 0), oldestQueuedSeconds: Number.isFinite(oldest) ? Math.max(0, (Date.now() - oldest) / 1000) : 0 } });
    } catch (error) {
      runtime.logger.error('sync_worker_request_failed', { error: String(error.message || error) });
      send(500, { error: 'Sync worker request failed' });
    }
  });
  server.requestTimeout = 20000;
  server.listen(Number(process.env.SYNC_WORKER_PORT || 3253), '0.0.0.0');
  const startup = async () => {
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/ensure-admin-regions-pmtiles.ts'], { stdio: 'inherit', env: process.env });
        child.on('error', reject);
        child.on('exit', (code) => code === 0 ? resolve(null) : reject(new Error(`Admin archive build exited with ${code}`)));
      });
    } catch (error) { runtime.logger.error('admin_archive_startup_failed', { error: String(error.message || error) }); }
    await runPostDbStartupTasks(runtime);
  };
  startup().catch((error) => runtime.logger.error('sync_worker_startup_failed', { error: String(error.message || error) }));
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (closing) return; closing = true;
    server.close();
    await runtime.stopRuntime(signal);
    process.exit(0);
  });
}
if (require.main === module) main().catch((error) => { console.error('Sync worker failed:', error.message); process.exitCode = 1; });
module.exports = { main };
