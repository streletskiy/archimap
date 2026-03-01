function validateSecurityConfig({
  nodeEnv,
  sessionSecret,
  appBaseUrl,
  sessionAllowMemoryFallback
}) {
  const isProduction = nodeEnv === 'production';
  const weakSessionSecret = sessionSecret === 'dev-secret-change-me';
  const hasAppBaseUrl = String(appBaseUrl || '').length > 0;
  const allowMemoryStoreFallback = Boolean(sessionAllowMemoryFallback);

  if (!isProduction) {
    if (weakSessionSecret) {
      console.warn('[security] SESSION_SECRET uses default value (allowed in non-production, unsafe for production)');
    }
    if (!hasAppBaseUrl) {
      console.warn('[security] APP_BASE_URL is empty, password reset links will be unavailable');
    }
    if (allowMemoryStoreFallback) {
      console.warn('[security] SESSION_ALLOW_MEMORY_FALLBACK=true (development mode)');
    }
    return;
  }

  if (weakSessionSecret || !hasAppBaseUrl || allowMemoryStoreFallback) {
    const issues = [];
    if (weakSessionSecret) issues.push('SESSION_SECRET is default');
    if (!hasAppBaseUrl) issues.push('APP_BASE_URL is required');
    if (allowMemoryStoreFallback) issues.push('SESSION_ALLOW_MEMORY_FALLBACK must be false in production');
    throw new Error(`[security] Refusing to start in production: ${issues.join('; ')}`);
  }
}

module.exports = {
  validateSecurityConfig
};
