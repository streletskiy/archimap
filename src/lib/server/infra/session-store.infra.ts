const session = require('express-session');
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');
const { createReadinessProbe } = require('./readiness.infra');

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
  sessionCookieSecure,
  redisUrl,
  sessionAllowMemoryFallback,
  maxAgeMs,
  logger = console
}) {
  const cookieSecure = typeof sessionCookieSecure === 'boolean' ? sessionCookieSecure : nodeEnv === 'production';

  const sessionConfig = {
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure,
      maxAge: maxAgeMs
    }
  };

  let redisClient = null;
  let connectedOnce = false;
  try {
    redisClient = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 1500,
        reconnectStrategy: (retries) => connectedOnce ? Math.min(5000, 100 * 2 ** Math.min(retries, 6)) + Math.floor(Math.random() * 100) : false
      },
      disableOfflineQueue: true
    });
    redisClient.on('error', (error) => {
      logger.error('session_redis_error', { error: String(error.message || error) });
    });
    redisClient.on('ready', () => { connectedOnce = true; });
    await redisClient.connect();
    logger.info('session_redis_connected', { redisUrl: sanitizeRedisUrl(redisUrl) });
    const middleware = session({
      ...sessionConfig,
      store: new RedisStore({
        client: redisClient,
        prefix: 'archimap:sess:'
      })
    });
    middleware.checkReadiness = createReadinessProbe(async () => redisClient.isReady && await redisClient.ping() === 'PONG');
    middleware.close = async () => { if (redisClient.isOpen) redisClient.destroy(); };
    return middleware;
  } catch (error) {
    if (!sessionAllowMemoryFallback) {
      throw new Error(
        `[session] Redis unavailable and SESSION_ALLOW_MEMORY_FALLBACK=false: ${String(error.message || error)}`,
        { cause: error }
      );
    }
    logger.warn('session_redis_fallback_memory_store', { error: String(error.message || error) });
    try {
      await redisClient?.quit?.();
    } catch {
      // ignore
    }
    const middleware = session(sessionConfig);
    middleware.checkReadiness = async () => true;
    middleware.close = async () => {};
    return middleware;
  }
}

module.exports = {
  initSessionStore
};
