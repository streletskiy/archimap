const { buildCspDirectives, serializeCspDirectives } = require('./csp.infra');

function applySecurityHeadersMiddleware(app, { nodeEnv, cspConnectOrigins = [], cspScriptHashes = [] }) {
  const cspHeader = serializeCspDirectives(buildCspDirectives({
    nodeEnv,
    extraConnectOrigins: cspConnectOrigins,
    scriptHashes: cspScriptHashes
  }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
    res.setHeader('Content-Security-Policy', cspHeader);

    if (nodeEnv === 'production' && req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    return next();
  });
}

module.exports = {
  applySecurityHeadersMiddleware
};
