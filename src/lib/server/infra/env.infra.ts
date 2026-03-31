const { z } = require('zod');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3252),
  SESSION_SECRET: z.string().min(1).default('dev-secret-change-me'),
  APP_BASE_URL: z.string().default(''),
  CSP_CONNECT_SRC_EXTRA: z.string().default(
    [
      'https://tiles.basemaps.cartocdn.com',
      'https://*.basemaps.cartocdn.com',
      'https://overpass-api.de',
      'https://lz4.overpass-api.de',
      'https://z.overpass-api.de',
      'https://maps.mail.ru',
      'https://overpass.openstreetmap.fr',
      'https://overpass.kumi.systems'
    ].join(',')
  ),
  DB_PROVIDER: z.string().default(''),
  DATABASE_URL: z.string().default(''),
  SQLITE_URL: z.string().default('')
});

function parseRuntimeEnv(rawEnv = process.env) {
  const parsed = envSchema.parse(rawEnv);
  const isProd = parsed.NODE_ENV === 'production';
  const weakSecret = parsed.SESSION_SECRET === 'dev-secret-change-me' || parsed.SESSION_SECRET.length < 16;

  if (weakSecret) {
    console.warn('\\n=======================================================================');
    console.warn('⚠️  WARNING: SESSION_SECRET is set to a default or weak value!');
    console.warn('   This is unsafe. Please set SESSION_SECRET environment variable.');
    console.warn('=======================================================================\\n');
  }

  if (isProd && weakSecret) {
    throw new Error('[env] SESSION_SECRET must be set to a strong value in production');
  }

  const rawDbProvider = String(parsed.DB_PROVIDER || '').trim().toLowerCase();
  const dbProviderDefault = parsed.NODE_ENV === 'development' ? 'sqlite' : 'postgres';
  const dbProvider = rawDbProvider || dbProviderDefault;
  if (!['sqlite', 'postgres'].includes(dbProvider)) {
    throw new Error('[env] DB_PROVIDER must be either "sqlite" or "postgres"');
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    sessionSecret: parsed.SESSION_SECRET,
    appBaseUrl: String(parsed.APP_BASE_URL || '').trim(),
    cspConnectSrcExtra: String(parsed.CSP_CONNECT_SRC_EXTRA || ''),
    dbProvider,
    databaseUrl: String(parsed.DATABASE_URL || '').trim(),
    sqliteUrl: String(parsed.SQLITE_URL || '').trim()
  };
}

module.exports = {
  parseRuntimeEnv
};
