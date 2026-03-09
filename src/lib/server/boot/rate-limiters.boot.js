function createRateLimiters(options = {}) {
  const { createSimpleRateLimiter } = options;
  if (typeof createSimpleRateLimiter !== 'function') {
    throw new Error('createRateLimiters: createSimpleRateLimiter is required');
  }

  return {
    searchRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Слишком много поисковых запросов, попробуйте позже'
    }),
    publicApiRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 180,
      message: 'Слишком много запросов, попробуйте позже'
    }),
    accountReadRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 120,
      message: 'Слишком много запросов аккаунта, попробуйте позже'
    }),
    adminApiRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 120,
      message: 'Слишком много административных запросов, попробуйте позже'
    }),
    filterDataRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 240,
      message: 'Слишком много запросов данных по зданиям, попробуйте позже'
    }),
    filterDataBboxRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Слишком много запросов bbox, попробуйте позже'
    }),
    filterMatchesRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 90,
      message: 'Слишком много запросов фильтрации, попробуйте позже'
    }),
    buildingsReadRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 120,
      message: 'Слишком много запросов к зданиям, попробуйте позже'
    }),
    buildingsWriteRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Слишком много изменений по зданиям, попробуйте позже'
    }),
    contoursStatusRateLimiter: createSimpleRateLimiter({
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Слишком много запросов статуса контуров, попробуйте позже'
    })
  };
}

module.exports = {
  createRateLimiters
};
