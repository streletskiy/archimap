const { createClient } = require('redis');

function createRateLimiterFactory(options = {}) {
  const { redisUrl, logger = console } = options;
  const memoryBuckets = new Map();
  let redisClient = null;
  let useRedis = false;
  let instanceCounter = 0;

  if (redisUrl) {
    redisClient = createClient({ url: redisUrl, socket: { connectTimeout: 1500 } });
    redisClient.on('error', (err) => logger.warn('rate_limiter_redis_error', { error: String(err.message || err) }));
    redisClient.connect().then(() => {
      useRedis = true;
      logger.info('rate_limiter_redis_connected');
    }).catch((err) => {
      logger.warn('rate_limiter_redis_fallback_memory', { error: String(err.message || err) });
    });
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of memoryBuckets.entries()) {
      if (value.resetAt <= now) memoryBuckets.delete(key);
    }
  }, 60000);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

  function createSimpleRateLimiter({ windowMs, maxRequests, message, prefix }) {
    const safePrefix = prefix || `rl${++instanceCounter}:`;

    return async (req, res, next) => {
      const key = `${safePrefix}${req.ip || 'unknown'}:${req.path}`;
      const now = Date.now();

      if (useRedis && redisClient?.isReady) {
        try {
          const multi = redisClient.multi();
          multi.incr(key);
          multi.pTTL(key);
          const results = await multi.exec();
          const count = Number(results[0]) || 1;
          const ttl = Number(results[1]);
          
          if (ttl < 0) {
            await redisClient.pExpire(key, windowMs);
          }

          if (count > maxRequests) {
            const retryAfterSec = Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1000));
            res.setHeader('Retry-After', String(retryAfterSec));
            return res.status(429).json({ code: 'ERR_RATE_LIMITED', error: message || 'Too many requests, please try again later' });
          }

          return next();
        } catch (err) {
          logger.warn('rate_limiter_redis_error_on_request', { error: String(err.message || err) });
          // Fall back to memory map
        }
      }

      let bucket = memoryBuckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        memoryBuckets.set(key, bucket);
      }
      bucket.count += 1;
      if (bucket.count > maxRequests) {
        const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        res.setHeader('Retry-After', String(retryAfterSec));
        return res.status(429).json({ code: 'ERR_RATE_LIMITED', error: message || 'Too many requests, please try again later' });
      }

      return next();
    };
  }

  return { createSimpleRateLimiter };
}

module.exports = {
  createRateLimiterFactory,
  createSimpleRateLimiter: createRateLimiterFactory().createSimpleRateLimiter
};
