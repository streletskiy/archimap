const { requireCsrfSession } = require('../services/csrf.service');
const { sendCachedJson } = require('../infra/http-cache.infra');
const { createAuthService } = require('./auth.service');
const { createUserProfileService } = require('./user-profile.service');

function applyResultHeaders(res, headers = {}) {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

function sendJsonResult(res, result, fallback = {}) {
  if (result?.headers) {
    applyResultHeaders(res, result.headers);
  }
  if (result?.error) {
    return res.status(result.status || 400).json({
      code: result.code || (Number(result.status || 400) >= 500 ? 'ERR_INTERNAL' : 'ERR_REQUEST_FAILED'),
      error: result.error
    });
  }
  return res.json(result?.payload || fallback);
}

function registerAuthRoutes(options = {}) {
  const {
    app,
    createSimpleRateLimiter
  } = options;

  const authService = createAuthService(options);
  const userProfileService = createUserProfileService({
    db: options.db,
    normalizeEmail: authService.normalizeEmail,
    isValidEmail: authService.isValidEmail,
    normalizeProfileName: authService.normalizeProfileName
  });

  const loginRateLimiter = createSimpleRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 20,
    message: 'Too many login attempts, please try again later'
  });

  const registrationCodeRequestRateLimiter = createSimpleRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 12,
    message: 'Too many registration code requests, please try again later'
  });

  const registrationConfirmRateLimiter = createSimpleRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 20,
    message: 'Too many registration confirmation attempts, please try again later'
  });

  const changePasswordRateLimiter = createSimpleRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 15,
    message: 'Too many password change attempts, please try again later'
  });

  const passwordResetRequestRateLimiter = createSimpleRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 12,
    message: 'Too many password reset requests, please try again later'
  });

  const passwordResetConfirmRateLimiter = createSimpleRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 20,
    message: 'Too many password reset attempts, please try again later'
  });

  app.get('/api/me', async (req, res) => {
    const payload = await authService.getCurrentSessionPayload(req);
    return sendCachedJson(req, res, payload, {
      cacheControl: 'private, no-cache'
    });
  });

  app.post('/api/login', loginRateLimiter, async (req, res) => {
    return sendJsonResult(res, await authService.login(req));
  });

  app.post('/api/register/start', registrationCodeRequestRateLimiter, async (req, res) => {
    return sendJsonResult(res, await authService.startRegistration(req));
  });

  app.post('/api/register/confirm-code', registrationConfirmRateLimiter, async (req, res) => {
    return sendJsonResult(res, await authService.confirmRegistrationCode(req));
  });

  app.post('/api/register/confirm-link', registrationConfirmRateLimiter, async (req, res) => {
    return sendJsonResult(res, await authService.confirmRegistrationLink(req));
  });

  app.post('/api/logout', requireCsrfSession, async (req, res) => {
    return sendJsonResult(res, await authService.logout(req), { ok: true });
  });

  app.post('/api/account/change-password', requireCsrfSession, changePasswordRateLimiter, async (req, res) => {
    return sendJsonResult(res, await authService.changePassword(req), { ok: true });
  });

  app.post('/api/password-reset/request', passwordResetRequestRateLimiter, async (req, res) => {
    return sendJsonResult(res, await authService.requestPasswordReset(req), { ok: true });
  });

  app.post('/api/password-reset/confirm', passwordResetConfirmRateLimiter, async (req, res) => {
    return sendJsonResult(res, await authService.confirmPasswordReset(req), { ok: true });
  });

  app.post('/api/account/profile', requireCsrfSession, async (req, res) => {
    return sendJsonResult(res, await userProfileService.updateCurrentProfile(req));
  });

  app.post('/api/admin/users/edit-permission', requireCsrfSession, authService.requireAdminSession, async (req, res) => {
    return sendJsonResult(res, await userProfileService.updateUserEditPermission(req.body || {}));
  });

  app.get('/api/admin/users', authService.requireAdminSession, async (req, res) => {
    const result = await userProfileService.listUsers(req.query || {});
    if (result.error) {
      return sendJsonResult(res, result);
    }
    return sendCachedJson(req, res, result.payload || { items: [] }, {
      cacheControl: 'private, no-cache'
    });
  });

  app.post('/api/admin/users/role', requireCsrfSession, authService.requireMasterAdminSession, async (req, res) => {
    return sendJsonResult(res, await userProfileService.updateUserRole(req.body || {}));
  });
}

module.exports = {
  registerAuthRoutes
};
