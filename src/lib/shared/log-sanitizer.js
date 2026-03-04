const SENSITIVE_KEY_PATTERN = /(token|password|pass|secret|email|session|csrf|authorization|cookie|set-cookie)/i;

function sanitizeUrl(url, options = {}) {
  const raw = String(url || '').trim();
  if (!raw) return '/';
  const whitelistQueryKeys = Array.isArray(options.whitelistQueryKeys)
    ? options.whitelistQueryKeys.map((key) => String(key || '').trim()).filter(Boolean)
    : [];

  let pathname = raw;
  let queryString = '';
  const queryIndex = raw.indexOf('?');
  if (queryIndex >= 0) {
    pathname = raw.slice(0, queryIndex) || '/';
    queryString = raw.slice(queryIndex + 1);
  }

  if (whitelistQueryKeys.length === 0 || !queryString) {
    return pathname || '/';
  }

  const allowed = new Set(whitelistQueryKeys);
  const params = new URLSearchParams(queryString);
  const keys = [];
  for (const [key] of params.entries()) {
    if (allowed.has(key)) keys.push(key);
  }
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) return pathname || '/';
  return `${pathname || '/'}?${uniqueKeys.join('&')}`;
}

function maskSensitive(input, options = {}) {
  const currentKey = String(options.currentKey || '').trim();
  if (input == null) return input;
  if (SENSITIVE_KEY_PATTERN.test(currentKey)) return '[REDACTED]';

  if (Array.isArray(input)) {
    return input.map((item) => maskSensitive(item));
  }

  if (typeof input === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = maskSensitive(value, { currentKey: key });
      }
    }
    return out;
  }

  return input;
}

module.exports = {
  sanitizeUrl,
  maskSensitive
};
