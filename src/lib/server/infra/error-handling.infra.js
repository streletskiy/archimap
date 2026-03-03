function registerErrorHandlers(app, { logger = console, nodeEnv = 'development' } = {}) {
  app.use((req, res, next) => {
    if (res.headersSent) return next();
    return res.status(404).json({ error: 'Not found' });
  });

  app.use((error, req, res, _next) => {
    const status = Number(error?.status || error?.statusCode || 500);
    const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    const requestId = String(req?.requestId || '');
    const exposeDetails = String(nodeEnv || '').toLowerCase() !== 'production';

    logger.error('http_unhandled_error', {
      requestId,
      path: req?.path || req?.url || '',
      method: req?.method || '',
      status: safeStatus,
      error: String(error?.message || error || 'Unknown error')
    });

    const payload = {
      error: safeStatus >= 500 ? 'Internal server error' : String(error?.message || 'Request failed'),
      requestId: requestId || null
    };

    if (exposeDetails && error?.stack) {
      payload.stack = String(error.stack);
    }

    return res.status(safeStatus).json(payload);
  });
}

module.exports = {
  registerErrorHandlers
};
