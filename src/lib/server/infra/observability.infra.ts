const { sanitizeUrl } = require('../../shared/log-sanitizer');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { getCacheMetrics } = require('./lru-cache.infra');

function initObservabilityInfra(app, options: LooseRecord = {}) {
  const logger = options.logger || console;
  const requestIdFactory =
    typeof options.requestIdFactory === 'function'
      ? options.requestIdFactory
      : () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const metricsEnabled = String(options.metricsEnabled ?? 'true').toLowerCase() !== 'false';
  const getVersionInfo =
    typeof options.getVersionInfo === 'function'
      ? options.getVersionInfo
      : () => ({
          version: '0.0.0',
          git: { describe: 'unknown', commit: 'unknown', dirty: false },
          buildTime: new Date().toISOString(),
          runtime: 'node',
          app: 'archimap'
        });

  const startedAt = Date.now();
  let requestTotal = 0;
  let request4xx = 0;
  let request5xx = 0;
  const buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
  const durations = new Map();
  const loopDelay = metricsEnabled ? monitorEventLoopDelay({ resolution: 20 }) : null;
  loopDelay?.enable();
  function routeLabel(path) {
    const normalized = String(path || '').split('?')[0];
    if (/^\/api\/(buildings\/filter-(matches(-batch)?|data(-bbox)?)|search-buildings(-map)?|me|contours-status)$/.test(normalized)) return normalized;
    if (/^\/api\/data\/regions\/\d+\/pmtiles$/.test(normalized)) return '/api/data/regions/:id/pmtiles';
    return normalized.startsWith('/_app/') ? '/_app/*' : 'other';
  }

  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    const incomingRequestId = String(req.get('x-request-id') || '').trim();
    const requestId = incomingRequestId || requestIdFactory();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
      requestTotal += 1;
      const status = Number(res.statusCode || 0);
      if (status >= 400 && status < 500) request4xx += 1;
      if (status >= 500) request5xx += 1;

      const elapsedNs = Number(process.hrtime.bigint() - started);
      const durationMs = Number((elapsedNs / 1e6).toFixed(2));
      if (metricsEnabled) {
        const route = routeLabel(req.path || req.url);
        const item = durations.get(route) || { count: 0, sum: 0, buckets: buckets.map(() => 0) };
        const seconds = durationMs / 1000;
        item.count++; item.sum += seconds;
        buckets.forEach((limit, index) => { if (seconds <= limit) item.buckets[index]++; });
        durations.set(route, item);
      }
      logger.info('http_request', {
        requestId,
        method: req.method,
        path: sanitizeUrl(req.originalUrl || req.url),
        status,
        durationMs,
        ip: req.ip
      });
    });

    return next();
  });

  app.get('/healthz', (req, res) => {
    const version = getVersionInfo();
    return res.status(200).json({
      ok: true,
      status: 'healthy',
      uptimeSec: Math.round(process.uptime()),
      version
    });
  });

  app.get('/readyz', async (req, res) => {
    let checks;
    try { checks =
      typeof options.getReadinessChecks === 'function'
        ? await options.getReadinessChecks()
        : { sessionStoreReady: true, dbReady: true };
    } catch { checks = { sessionStoreReady: false, dbReady: false }; }
    const ready = Object.values(checks).every((value) => Boolean(value));
    const payload = {
      ok: ready,
      status: ready ? 'ready' : 'not_ready',
      checks
    };
    return res.status(ready ? 200 : 503).json(payload);
  });

  app.get('/metrics', async (req, res) => {
    if (!metricsEnabled) {
      return res.status(404).json({ code: 'ERR_METRICS_DISABLED', error: 'Metrics disabled' });
    }
    if (typeof options.getMetricsToken === 'function') {
      const validToken = await options.getMetricsToken();
      if (validToken) {
        const authHeader = req.get('Authorization') || '';
        const providedToken = authHeader.replace(/^Bearer\s+/i, '').trim();
        if (providedToken !== validToken) {
          return res.status(401).json({ code: 'ERR_METRICS_UNAUTHORIZED', error: 'Unauthorized metrics access' });
        }
      }
    }
    const uptimeSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const heapUsed = Number(process.memoryUsage?.().heapUsed || 0);
    const lines = [
      '# HELP archimap_uptime_seconds Process uptime in seconds',
      '# TYPE archimap_uptime_seconds gauge',
      `archimap_uptime_seconds ${uptimeSec}`,
      '# HELP archimap_http_requests_total Total HTTP requests',
      '# TYPE archimap_http_requests_total counter',
      `archimap_http_requests_total ${requestTotal}`,
      '# HELP archimap_http_requests_4xx_total Total HTTP 4xx responses',
      '# TYPE archimap_http_requests_4xx_total counter',
      `archimap_http_requests_4xx_total ${request4xx}`,
      '# HELP archimap_http_requests_5xx_total Total HTTP 5xx responses',
      '# TYPE archimap_http_requests_5xx_total counter',
      `archimap_http_requests_5xx_total ${request5xx}`,
      '# HELP archimap_process_heap_used_bytes Process heap used in bytes',
      '# TYPE archimap_process_heap_used_bytes gauge',
      `archimap_process_heap_used_bytes ${heapUsed}`
    ];
    lines.push('# TYPE archimap_http_request_duration_seconds histogram');
    for (const [route, item] of durations) {
      buckets.forEach((limit, index) => lines.push(`archimap_http_request_duration_seconds_bucket{route="${route}",le="${limit}"} ${item.buckets[index]}`));
      lines.push(`archimap_http_request_duration_seconds_bucket{route="${route}",le="+Inf"} ${item.count}`);
      lines.push(`archimap_http_request_duration_seconds_sum{route="${route}"} ${item.sum}`);
      lines.push(`archimap_http_request_duration_seconds_count{route="${route}"} ${item.count}`);
    }
    const delay = Number(loopDelay?.percentile(99) || 0) / 1e9;
    lines.push('# TYPE archimap_event_loop_delay_p99_seconds gauge', `archimap_event_loop_delay_p99_seconds ${Number.isFinite(delay) ? delay : 0}`);
    const pool = options.getPoolMetrics?.();
    for (const key of ['total', 'idle', 'waiting']) {
      if (pool) lines.push(`# TYPE archimap_db_pool_${key} gauge`, `archimap_db_pool_${key} ${Number(pool[key] || 0)}`);
    }
    for (const [name, stats] of getCacheMetrics()) {
      for (const key of ['hits', 'misses', 'evictions']) lines.push(`archimap_cache_${key}_total{cache="${name}"} ${stats[key]}`);
    }
    try {
      const sync = await options.getSyncMetrics?.();
      if (sync) lines.push('archimap_sync_worker_up 1', `archimap_sync_running ${sync.running ? 1 : 0}`, `archimap_sync_queued ${Number(sync.queued || 0)}`, `archimap_sync_oldest_queued_seconds ${Number(sync.oldestQueuedSeconds || 0)}`);
    } catch { lines.push('archimap_sync_worker_up 0'); }
    res.type('text/plain; version=0.0.4; charset=utf-8');
    return res.send(`${lines.join('\n')}\n`);
  });
  return () => loopDelay?.disable();
}

module.exports = {
  initObservabilityInfra
};
