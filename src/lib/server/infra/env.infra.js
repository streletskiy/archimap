const { z } = require('zod');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3252),
  SESSION_SECRET: z.string().min(1).default('dev-secret-change-me'),
  APP_BASE_URL: z.string().default(''),
  BOOTSTRAP_ADMIN_ENABLED: z.string().optional(),
  BOOTSTRAP_ADMIN_SECRET: z.string().optional(),
  BOOTSTRAP_ADMIN_ALLOWED_IPS: z.string().default('127.0.0.1,::1'),
  CSP_CONNECT_SRC_EXTRA: z.string().default('https://tiles.basemaps.cartocdn.com,https://*.basemaps.cartocdn.com')
});

function parseBool(rawValue, defaultValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return defaultValue;
}

function parseRuntimeEnv(rawEnv = process.env) {
  const parsed = envSchema.parse(rawEnv);
  const isProd = parsed.NODE_ENV === 'production';
  const bootstrapEnabledDefault = isProd ? false : true;
  const bootstrapAdminEnabled = parseBool(parsed.BOOTSTRAP_ADMIN_ENABLED, bootstrapEnabledDefault);
  const bootstrapAdminSecret = String(parsed.BOOTSTRAP_ADMIN_SECRET || '').trim();
  const bootstrapAdminAllowedIps = String(parsed.BOOTSTRAP_ADMIN_ALLOWED_IPS || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (isProd) {
    if (parsed.SESSION_SECRET === 'dev-secret-change-me' || parsed.SESSION_SECRET.length < 16) {
      throw new Error('[env] SESSION_SECRET must be set to a strong value in production');
    }
    if (bootstrapAdminEnabled && !bootstrapAdminSecret) {
      throw new Error('[env] BOOTSTRAP_ADMIN_SECRET is required when BOOTSTRAP_ADMIN_ENABLED=true in production');
    }
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    sessionSecret: parsed.SESSION_SECRET,
    appBaseUrl: String(parsed.APP_BASE_URL || '').trim(),
    bootstrapAdminEnabled,
    bootstrapAdminSecret,
    bootstrapAdminAllowedIps,
    cspConnectSrcExtra: String(parsed.CSP_CONNECT_SRC_EXTRA || '')
  };
}

module.exports = {
  parseRuntimeEnv
};
