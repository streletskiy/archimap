const session = require('express-session');
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');

function sanitizeRedisUrl(redisUrl) {
  const raw = String(redisUrl || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '[redacted]';
  }
}

async function initSessionStore({
  sessionSecret,
  nodeEnv,
  redisUrl,
  sessionAllowMemoryFallback,
  maxAgeMs,
  logger = console
}) {
  const sessionConfig = {
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: nodeEnv === 'production',
      maxAge: maxAgeMs
    }
  };

  let redisClient = null;
  try {
    redisClient = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 1500,
        reconnectStrategy: () => false
      }
    });
    redisClient.on('error', (error) => {
      logger.error('session_redis_error', { error: String(error.message || error) });
    });
    await redisClient.connect();
    logger.info('session_redis_connected', { redisUrl: sanitizeRedisUrl(redisUrl) });
    return session({
      ...sessionConfig,
      store: new RedisStore({
        client: redisClient,
        prefix: 'archimap:sess:'
      })
    });
  } catch (error) {
    if (!sessionAllowMemoryFallback) {
      throw new Error(`[session] Redis unavailable and SESSION_ALLOW_MEMORY_FALLBACK=false: ${String(error.message || error)}`);
    }
    logger.warn('session_redis_fallback_memory_store', { error: String(error.message || error) });
    try {
      await redisClient?.quit?.();
    } catch {
      // ignore
    }
    return session(sessionConfig);
  }
}

module.exports = {
  initSessionStore
};
