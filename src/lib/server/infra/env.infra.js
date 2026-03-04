const { z } = require('zod');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3252),
  SESSION_SECRET: z.string().min(1).default('dev-secret-change-me'),
  APP_BASE_URL: z.string().default(''),
  CSP_CONNECT_SRC_EXTRA: z.string().default('https://tiles.basemaps.cartocdn.com,https://*.basemaps.cartocdn.com')
});

function parseRuntimeEnv(rawEnv = process.env) {
  const parsed = envSchema.parse(rawEnv);
  const isProd = parsed.NODE_ENV === 'production';

  if (isProd) {
    if (parsed.SESSION_SECRET === 'dev-secret-change-me' || parsed.SESSION_SECRET.length < 16) {
      throw new Error('[env] SESSION_SECRET must be set to a strong value in production');
    }
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    sessionSecret: parsed.SESSION_SECRET,
    appBaseUrl: String(parsed.APP_BASE_URL || '').trim(),
    cspConnectSrcExtra: String(parsed.CSP_CONNECT_SRC_EXTRA || '')
  };
}

module.exports = {
  parseRuntimeEnv
};
