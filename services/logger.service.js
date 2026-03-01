const crypto = require('crypto');

function normalizeLevel(value) {
  const normalized = String(value || 'info').trim().toLowerCase();
  if (['debug', 'info', 'warn', 'error'].includes(normalized)) return normalized;
  return 'info';
}

const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function createLogger(options = {}) {
  const level = normalizeLevel(options.level || process.env.LOG_LEVEL || 'info');
  const service = String(options.service || 'archimap').trim() || 'archimap';
  const minPriority = LEVEL_PRIORITY[level];

  function write(nextLevel, message, fields = {}) {
    if (LEVEL_PRIORITY[nextLevel] < minPriority) return;
    const payload = {
      ts: new Date().toISOString(),
      level: nextLevel,
      service,
      msg: String(message || ''),
      ...fields
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  return {
    level,
    child(extraFields = {}) {
      const base = extraFields && typeof extraFields === 'object' ? { ...extraFields } : {};
      return {
        debug(message, fields) { write('debug', message, { ...base, ...(fields || {}) }); },
        info(message, fields) { write('info', message, { ...base, ...(fields || {}) }); },
        warn(message, fields) { write('warn', message, { ...base, ...(fields || {}) }); },
        error(message, fields) { write('error', message, { ...base, ...(fields || {}) }); },
        log(message, fields) { write('info', message, { ...base, ...(fields || {}) }); }
      };
    },
    debug(message, fields) { write('debug', message, fields); },
    info(message, fields) { write('info', message, fields); },
    warn(message, fields) { write('warn', message, fields); },
    error(message, fields) { write('error', message, fields); },
    log(message, fields) { write('info', message, fields); },
    requestId() {
      if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      return crypto.randomBytes(16).toString('hex');
    }
  };
}

module.exports = {
  createLogger
};
