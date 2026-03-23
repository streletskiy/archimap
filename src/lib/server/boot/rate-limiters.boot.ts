function createRateLimiters(options: LooseRecord = {}) {
  const { createSimpleRateLimiter } = options;
  if (typeof createSimpleRateLimiter !== 'function') {
    throw new Error('createRateLimiters: createSimpleRateLimiter is required');
  }

  return {
    searchRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many search requests, please try again later'
    }),
    publicApiRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 180,
      message: 'Too many requests, please try again later'
    }),
    accountReadRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 120,
      message: 'Too many account requests, please try again later'
    }),
    adminApiRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 120,
      message: 'Too many admin requests, please try again later'
    }),
    filterDataRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 240,
      message: 'Too many building data requests, please try again later'
    }),
    filterDataBboxRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many bbox requests, please try again later'
    }),
    filterMatchesRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 90,
      message: 'Too many filtering requests, please try again later'
    }),
    buildingsReadRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 120,
      message: 'Too many building requests, please try again later'
    }),
    buildingsWriteRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many building edit requests, please try again later'
    }),
    contoursStatusRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many contour status requests, please try again later'
    })
  };
}

module.exports = {
  createRateLimiters
};
