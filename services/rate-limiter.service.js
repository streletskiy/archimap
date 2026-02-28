function createSimpleRateLimiter({ windowMs, maxRequests, message }) {
  const buckets = new Map();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of buckets.entries()) {
      if (value.resetAt <= now) buckets.delete(key);
    }
  }, Math.max(1000, Math.floor(windowMs / 2)));
  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  return (req, res, next) => {
    const key = `${req.ip || 'unknown'}:${req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: message || 'Слишком много запросов, попробуйте позже' });
    }

    return next();
  };
}

module.exports = {
  createSimpleRateLimiter
};
