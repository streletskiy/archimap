const crypto = require('crypto');
const fs = require('fs');

function normalizeOrigins(input) {
  const values = Array.isArray(input)
    ? input
    : String(input || '').split(',');
  const out = [];
  for (const raw of values) {
    const origin = String(raw || '').trim();
    if (!origin) continue;
    if (!/^https?:\/\//.test(origin)) continue;
    out.push(origin.replace(/\/+$/, ''));
  }
  return [...new Set(out)];
}

function buildCspDirectives({
  nodeEnv = 'development',
  extraConnectOrigins = [],
  scriptHashes = []
} = {}) {
  const isProd = String(nodeEnv || '').toLowerCase() === 'production';
  const mapOrigins = normalizeOrigins(extraConnectOrigins);
  const normalizedScriptHashes = Array.isArray(scriptHashes)
    ? scriptHashes.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const connectSrc = ["'self'", ...mapOrigins];
  const imgSrc = ["'self'", 'data:', 'blob:', ...mapOrigins];
  const fontSrc = ["'self'", 'data:', ...mapOrigins];

  const directives = {
    'default-src': ["'self'"],
    'script-src': isProd
      ? ["'self'", ...normalizedScriptHashes]
      : ["'self'", "'unsafe-eval'", ...normalizedScriptHashes],
    'style-src': ["'self'"],
    'style-src-attr': ["'unsafe-inline'"],
    'img-src': imgSrc,
    'font-src': fontSrc,
    'connect-src': isProd
      ? connectSrc
      : [...connectSrc, 'ws:', 'wss:'],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"]
  };

  return directives;
}

function extractInlineScriptHashesFromHtml(html) {
  const text = String(html || '');
  const hashes = [];
  const scriptTagPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptTagPattern.exec(text)) !== null) {
    const attrs = String(match[1] || '');
    const body = String(match[2] || '');
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (!body.trim()) continue;
    const hash = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
    hashes.push(`'sha256-${hash}'`);
  }
  return [...new Set(hashes)];
}

function collectInlineScriptHashesFromFile(filePath) {
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    return extractInlineScriptHashesFromHtml(html);
  } catch {
    return [];
  }
}

function serializeCspDirectives(directives) {
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

module.exports = {
  buildCspDirectives,
  serializeCspDirectives,
  normalizeOrigins,
  extractInlineScriptHashesFromHtml,
  collectInlineScriptHashesFromFile
};
