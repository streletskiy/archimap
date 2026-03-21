type LooseAdminError = Error & {
  status?: number;
  code?: string;
  details?: LooseRecord;
};

function createAdminError(status, message, options: LooseRecord = {}) {
  const error = new Error(String(message || 'Admin request failed')) as LooseAdminError;
  error.status = Number(status) || 400;
  const fallbackCode = error.status === 401
    ? 'ERR_AUTH_REQUIRED'
    : error.status === 403
      ? 'ERR_ACCESS_DENIED'
      : error.status === 404
        ? 'ERR_NOT_FOUND'
        : error.status >= 500
          ? 'ERR_INTERNAL'
          : 'ERR_REQUEST_FAILED';
  error.code = String(options.code || fallbackCode);
  if (options.details && typeof options.details === 'object') {
    error.details = options.details as LooseRecord;
  }
  return error;
}

function resolveAppDisplayName({ appDisplayName, getAppDisplayName }: LooseRecord = {}) {
  if (typeof getAppDisplayName === 'function') {
    return String(getAppDisplayName() || 'archimap').trim() || 'archimap';
  }
  return String(appDisplayName || 'archimap').trim() || 'archimap';
}

function resolveAppBaseUrl({ appBaseUrl, getAppBaseUrl }: LooseRecord = {}) {
  if (typeof getAppBaseUrl === 'function') {
    return String(getAppBaseUrl() || '').trim();
  }
  return String(appBaseUrl || '').trim();
}

function requireMasterAdmin(req, res, next) {
  if (!req?.session?.user) {
    return res.status(401).json({ code: 'ERR_AUTH_REQUIRED', error: 'Authentication is required' });
  }
  if (!req.session.user.isMasterAdmin) {
    return res.status(403).json({ code: 'ERR_MASTER_ADMIN_REQUIRED', error: 'Master admin privileges are required' });
  }
  return next();
}

function isLikelyEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254) return false;
  if (email.includes(' ') || email.includes('\t') || email.includes('\n')) return false;
  const atIndex = email.indexOf('@');
  if (atIndex <= 0 || atIndex !== email.lastIndexOf('@')) return false;
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  if (!local || !domain) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  return domain.includes('.');
}

function parseLimit(raw, fallback = 200, min = 1, max = 1000) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const value = Math.trunc(n);
  return Math.max(min, Math.min(max, value));
}

function parsePositiveId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function parseRegionId(raw) {
  return parsePositiveId(raw);
}

function parseOsmTarget(value) {
  const target = value && typeof value === 'object' ? value : {};
  const osmType = String(target.osmType || '').trim();
  const osmId = Number(target.osmId);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) {
    return null;
  }
  return { osmType, osmId };
}

module.exports = {
  createAdminError,
  resolveAppDisplayName,
  resolveAppBaseUrl,
  requireMasterAdmin,
  isLikelyEmail,
  parseLimit,
  parsePositiveId,
  parseRegionId,
  parseOsmTarget
};
