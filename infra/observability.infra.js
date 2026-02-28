function initObservabilityInfra(app, options = {}) {
  const logger = options.logger || console;
  const requestIdFactory = typeof options.requestIdFactory === 'function'
    ? options.requestIdFactory
    : (() => `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const metricsEnabled = String(options.metricsEnabled ?? 'true').toLowerCase() !== 'false';

  const startedAt = Date.now();
  let requestTotal = 0;
  let request4xx = 0;
  let request5xx = 0;

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
      logger.info('http_request', {
        requestId,
        method: req.method,
        path: req.originalUrl || req.url,
        status,
        durationMs,
        ip: req.ip
      });
    });

    return next();
  });

  app.get('/healthz', (req, res) => {
    return res.status(200).json({
      ok: true,
      status: 'healthy',
      uptimeSec: Math.round(process.uptime())
    });
  });

  app.get('/readyz', (req, res) => {
    const checks = typeof options.getReadinessChecks === 'function'
      ? options.getReadinessChecks()
      : { sessionStoreReady: true, dbReady: true };
    const ready = Object.values(checks).every((value) => Boolean(value));
    const payload = {
      ok: ready,
      status: ready ? 'ready' : 'not_ready',
      checks
    };
    return res.status(ready ? 200 : 503).json(payload);
  });

  app.get('/metrics', (req, res) => {
    if (!metricsEnabled) {
      return res.status(404).json({ error: 'Metrics disabled' });
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
    res.type('text/plain; version=0.0.4; charset=utf-8');
    return res.send(`${lines.join('\n')}\n`);
  });
}

module.exports = {
  initObservabilityInfra
};
