const session = require('express-session');
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');

async function initSessionStore({
  sessionSecret,
  nodeEnv,
  redisUrl,
  sessionAllowMemoryFallback,
  maxAgeMs
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
      console.error(`[session] Redis error: ${String(error.message || error)}`);
    });
    await redisClient.connect();
    console.log(`[session] Redis store connected: ${redisUrl}`);
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
    console.error(`[session] Redis unavailable, fallback to MemoryStore: ${String(error.message || error)}`);
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
