const crypto = require('crypto');
const { sendMailWithFallback } = require('../services/smtp-transport.service');
const {
  registrationCodeHtmlTemplate,
  registrationCodeTextTemplate,
  passwordResetHtmlTemplate,
  passwordResetTextTemplate
} = require('../email-templates');
const {
  appendLocaleParam,
  getEmailCopy,
  resolveEmailLocale
} = require('../email-templates/localization');

function createAuthService({
  db,
  logger = console,
  sessionSecret,
  userEditRequiresPermission,
  getUserEditRequiresPermission,
  registrationEnabled,
  getRegistrationEnabled,
  registrationCodeTtlMinutes,
  registrationCodeResendCooldownSec,
  registrationCodeMaxAttempts,
  registrationMinPasswordLength,
  passwordResetTtlMinutes,
  appBaseUrl,
  getAppBaseUrl,
  appDisplayName,
  getAppDisplayName,
  smtp,
  getSmtpConfig
}: LooseRecord) {
  const sessionUserCache = new Map();
  const SESSION_USER_TTL_MS = 60000;

  function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  }

  function isValidEmail(value) {
    const email = normalizeEmail(value);
    if (!email || email.length > 254) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
  }

  function verifyPassword(password, stored) {
    const value = String(stored || '');
    const [algorithm, salt, expectedHash] = value.split('$');
    if (algorithm !== 'scrypt' || !salt || !expectedHash) return false;
    const calculatedHash = crypto.scryptSync(password, salt, 64).toString('hex');
    const left = Buffer.from(calculatedHash, 'hex');
    const right = Buffer.from(expectedHash, 'hex');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  }

  function hashRegistrationCode(secret, email, code) {
    return crypto
      .createHash('sha256')
      .update(`${secret}:${normalizeEmail(email)}:${String(code || '').trim()}`)
      .digest('hex');
  }

  function generateRegistrationCode() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  }

  function hashRegistrationVerifyToken(secret, token) {
    return crypto
      .createHash('sha256')
      .update(`${secret}:registration-verify:${String(token || '').trim()}`)
      .digest('hex');
  }

  function generateRegistrationVerifyToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  function hashPasswordResetToken(secret, token) {
    return crypto
      .createHash('sha256')
      .update(`${secret}:password-reset:${String(token || '').trim()}`)
      .digest('hex');
  }

  function generatePasswordResetToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  function generateCsrfToken() {
    return crypto.randomBytes(24).toString('hex');
  }

  function resolveSmtpConfig() {
    const raw: LooseRecord = typeof getSmtpConfig === 'function' ? (getSmtpConfig() || {}) : (smtp || {});
    return {
      url: String(raw.url || '').trim(),
      host: String(raw.host || '').trim(),
      port: Number(raw.port || 587),
      secure: String(raw.secure ?? 'false').toLowerCase() === 'true' || raw.secure === true,
      user: String(raw.user || '').trim(),
      pass: String(raw.pass || '').trim(),
      from: String(raw.from || raw.user || '').trim()
    };
  }

  function ensureCsrfToken(req) {
    if (!req?.session) return null;
    if (!req.session.csrfToken) {
      req.session.csrfToken = generateCsrfToken();
    }
    return String(req.session.csrfToken || '');
  }

  function resolveUserEditRequiresPermission() {
    if (typeof getUserEditRequiresPermission === 'function') {
      return Boolean(getUserEditRequiresPermission());
    }
    return Boolean(userEditRequiresPermission);
  }

  function resolveRegistrationEnabled() {
    if (typeof getRegistrationEnabled === 'function') {
      return Boolean(getRegistrationEnabled());
    }
    return Boolean(registrationEnabled);
  }

  function resolveAppDisplayName() {
    if (typeof getAppDisplayName === 'function') {
      return String(getAppDisplayName() || 'archimap').trim() || 'archimap';
    }
    return String(appDisplayName || 'archimap').trim() || 'archimap';
  }

  function normalizeProfileName(value, maxLen = 80) {
    const text = String(value || '').trim();
    if (!text) return null;
    return text.slice(0, maxLen);
  }

  function resolveAppBaseUrl(_req) {
    const value = typeof getAppBaseUrl === 'function' ? getAppBaseUrl() : appBaseUrl;
    const text = String(value || '').trim();
    if (!text) return '';
    return text.replace(/\/+$/, '');
  }

  async function establishAuthenticatedSession(req, sessionUser) {
    const nextUser = sessionUser && typeof sessionUser === 'object' ? sessionUser : null;
    if (!nextUser) {
      throw new Error('Session user is required');
    }
    if (!req?.session || typeof req.session.regenerate !== 'function') {
      throw new Error('Session is not initialized');
    }

    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((error) => {
        if (error) return reject(error);
        return resolve();
      });
    });

    req.session.user = nextUser;
    const csrfToken = ensureCsrfToken(req);
    await new Promise<void>((resolve, reject) => {
      req.session.save((error) => {
        if (error) return reject(error);
        return resolve();
      });
    });
    return { user: req.session.user, csrfToken };
  }

  function buildSessionUserFromRow(row) {
    const isMasterAdmin = Number(row?.is_master_admin || 0) > 0;
    const isAdmin = isMasterAdmin || Number(row?.is_admin || 0) > 0;
    const canEdit = Number(row?.can_edit || 0) > 0;
    const canEditBuildings = isAdmin ? true : (resolveUserEditRequiresPermission() ? canEdit : true);
    return {
      username: String(row?.email || ''),
      email: String(row?.email || ''),
      isAdmin,
      isMasterAdmin,
      canEdit,
      canEditBuildings,
      firstName: normalizeProfileName(row?.first_name),
      lastName: normalizeProfileName(row?.last_name)
    };
  }

  async function resolveSessionUser(req) {
    const sessionUser = req?.session?.user;
    if (!sessionUser) return null;

    const email = normalizeEmail(sessionUser.email);
    if (!isValidEmail(email)) return null;

    const now = Date.now();
    const cached = sessionUserCache.get(email);
    if (cached && now < cached.expiresAt) {
      req.session.user = cached.user;
      return cached.user;
    }

    const row = await db.prepare('SELECT email, first_name, last_name, can_edit, is_admin, is_master_admin FROM auth.users WHERE email = ?').get(email);
    if (!row) {
      sessionUserCache.delete(email);
      return null;
    }
    const user = buildSessionUserFromRow(row);
    req.session.user = user;
    sessionUserCache.set(email, { user, expiresAt: now + SESSION_USER_TTL_MS });

    if (sessionUserCache.size > 1000) {
      for (const [key, entry] of sessionUserCache.entries()) {
        if (now >= entry.expiresAt) sessionUserCache.delete(key);
      }
    }

    return user;
  }

  async function requireAdminSession(req, res, next) {
    const user = await resolveSessionUser(req);
    if (!user || !user.isAdmin) {
      return res.status(403).json({ code: 'ERR_ADMIN_REQUIRED', error: 'Admin privileges are required' });
    }
    return next();
  }

  async function requireMasterAdminSession(req, res, next) {
    const user = await resolveSessionUser(req);
    if (!user || !user.isMasterAdmin) {
      return res.status(403).json({ code: 'ERR_MASTER_ADMIN_REQUIRED', error: 'Master admin privileges are required' });
    }
    return next();
  }

  function isEmailDeliveryConfigured() {
    const smtpConfig = resolveSmtpConfig();
    if (smtpConfig.url) return Boolean(smtpConfig.from);
    return Boolean(smtpConfig.host && smtpConfig.port && smtpConfig.user && smtpConfig.pass && smtpConfig.from);
  }

  async function sendRegistrationCodeEmail({ to, code, expiresInMinutes, confirmUrl, locale }: LooseRecord) {
    const effectiveAppDisplayName = resolveAppDisplayName();
    const smtpConfig = resolveSmtpConfig();
    const currentLocale = resolveEmailLocale({ locale });
    const copy = getEmailCopy(currentLocale);
    const localizedConfirmUrl = appendLocaleParam(confirmUrl, currentLocale);
    const mailOptions = {
      from: smtpConfig.from,
      to,
      subject: `${effectiveAppDisplayName}: ${copy.registration.subject}`,
      text: registrationCodeTextTemplate({
        code,
        expiresInMinutes,
        appDisplayName: effectiveAppDisplayName,
        confirmUrl: localizedConfirmUrl,
        locale: currentLocale
      }),
      html: registrationCodeHtmlTemplate({
        code,
        expiresInMinutes,
        appDisplayName: effectiveAppDisplayName,
        confirmUrl: localizedConfirmUrl,
        locale: currentLocale
      })
    };
    return sendMailWithFallback(smtpConfig, mailOptions, {
      logger,
      logContext: { flow: 'registration', to: '[REDACTED]' }
    });
  }

  async function sendPasswordResetEmail({ to, resetUrl, expiresInMinutes, locale }: LooseRecord) {
    const effectiveAppDisplayName = resolveAppDisplayName();
    const smtpConfig = resolveSmtpConfig();
    const currentLocale = resolveEmailLocale({ locale });
    const copy = getEmailCopy(currentLocale);
    const localizedResetUrl = appendLocaleParam(resetUrl, currentLocale);
    const mailOptions = {
      from: smtpConfig.from,
      to,
      subject: `${effectiveAppDisplayName}: ${copy.passwordReset.subject}`,
      text: passwordResetTextTemplate({
        resetUrl: localizedResetUrl,
        expiresInMinutes,
        appDisplayName: effectiveAppDisplayName,
        locale: currentLocale
      }),
      html: passwordResetHtmlTemplate({
        resetUrl: localizedResetUrl,
        expiresInMinutes,
        appDisplayName: effectiveAppDisplayName,
        locale: currentLocale
      })
    };
    return sendMailWithFallback(smtpConfig, mailOptions, {
      logger,
      logContext: { flow: 'password_reset', to: '[REDACTED]' }
    });
  }

  async function completeRegistration(row: LooseRecord, options: LooseRecord = {}) {
    const email = normalizeEmail(row?.email);
    const passwordHash = String(row?.password_hash || '');
    const firstName = normalizeProfileName(row?.first_name);
    const lastName = normalizeProfileName(row?.last_name);
    const makeAdmin = Boolean(options.makeAdmin);
    const makeMasterAdmin = Boolean(options.makeMasterAdmin);
    const allowEdit = Boolean(options.allowEdit || makeAdmin || makeMasterAdmin);
    const deleteRegistrationCode = options.deleteRegistrationCode !== false;
    if (!isValidEmail(email) || !passwordHash) {
      return { status: 400, code: 'ERR_REGISTRATION_DATA_CORRUPTED', error: 'Registration data is corrupted. Start over.' };
    }

    const tx = db.transaction(async (nextEmail, nextPasswordHash, nextFirstName, nextLastName, nextCanEdit, nextIsAdmin, nextIsMasterAdmin) => {
      await db.prepare('INSERT INTO auth.users (email, password_hash, first_name, last_name, can_edit, is_admin, is_master_admin) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(nextEmail, nextPasswordHash, nextFirstName, nextLastName, nextCanEdit ? 1 : 0, nextIsAdmin ? 1 : 0, nextIsMasterAdmin ? 1 : 0);
      if (deleteRegistrationCode) {
        await db.prepare('DELETE FROM auth.email_registration_codes WHERE email = ?').run(nextEmail);
      }
    });

    try {
      await tx(email, passwordHash, firstName, lastName, allowEdit, makeAdmin, makeMasterAdmin);
    } catch (error) {
      if (String(error?.code || '') === '23505' || String(error?.message || '').includes('UNIQUE constraint failed: auth.users.email')) {
        return { status: 409, code: 'ERR_EMAIL_ALREADY_REGISTERED', error: 'A user with this email is already registered' };
      }
      throw error;
    }

    return {
      payload: {
        ok: true,
        user: {
          username: email,
          email,
          isAdmin: makeAdmin || makeMasterAdmin,
          isMasterAdmin: makeMasterAdmin,
          canEdit: allowEdit,
          canEditBuildings: (makeAdmin || makeMasterAdmin) ? true : (resolveUserEditRequiresPermission() ? allowEdit : true),
          firstName: firstName || null,
          lastName: lastName || null
        }
      }
    };
  }

  async function getCurrentSessionPayload(req) {
    const user = await resolveSessionUser(req);
    const authenticated = Boolean(user);
    const csrfToken = user ? ensureCsrfToken(req) : null;
    return { authenticated, user, csrfToken };
  }

  async function login(req) {
    const body = req.body || {};
    const username = String(body.username ?? body.email ?? '').trim();
    const password = String(body.password ?? '');

    const email = normalizeEmail(username);
    if (isValidEmail(email)) {
      const user = await db.prepare('SELECT email, password_hash, first_name, last_name, can_edit, is_admin, is_master_admin FROM auth.users WHERE email = ?').get(email);
      if (user && verifyPassword(password, user.password_hash)) {
        let authSession;
        try {
          authSession = await establishAuthenticatedSession(req, buildSessionUserFromRow(user));
        } catch (error) {
          logger.error('auth_login_session_failed', { error: String(error.message || error) });
          return { status: 500, code: 'ERR_SESSION_CREATE_FAILED', error: 'Failed to create session' };
        }
        return {
          payload: {
            ok: true,
            user: authSession.user,
            csrfToken: authSession.csrfToken
          }
        };
      }
    }

    return { status: 401, code: 'ERR_LOGIN_FAILED', error: 'Invalid email or password' };
  }

  async function startRegistration(req) {
    if (!resolveRegistrationEnabled()) {
      return { status: 403, code: 'ERR_REGISTRATION_DISABLED', error: 'Registration is disabled' };
    }

    const locale = resolveEmailLocale({ req, locale: req.body?.locale });
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const firstName = normalizeProfileName(req.body?.firstName);
    const lastName = normalizeProfileName(req.body?.lastName);
    const acceptTerms = req.body?.acceptTerms === true;
    const acceptPrivacy = req.body?.acceptPrivacy === true;
    if (!isValidEmail(email)) {
      return { status: 400, code: 'ERR_INVALID_EMAIL', error: 'Provide a valid email' };
    }
    if (password.length < registrationMinPasswordLength) {
      return { status: 400, code: 'ERR_PASSWORD_TOO_SHORT', error: `Password must be at least ${registrationMinPasswordLength} characters long` };
    }
    if (!acceptTerms || !acceptPrivacy) {
      return { status: 400, code: 'ERR_REGISTRATION_CONSENT_REQUIRED', error: 'Terms of service and privacy policy must be accepted for registration' };
    }

    if (!isEmailDeliveryConfigured()) {
      return { status: 503, code: 'ERR_EMAIL_DELIVERY_NOT_CONFIGURED', error: 'Email delivery is not configured on the server' };
    }

    const baseUrl = resolveAppBaseUrl(req);
    if (!baseUrl) {
      return { status: 500, code: 'ERR_APP_BASE_URL_UNAVAILABLE', error: 'Failed to resolve app base URL for the confirmation link' };
    }

    const existingUser = await db.prepare('SELECT id FROM auth.users WHERE email = ?').get(email);
    if (existingUser) {
      return { status: 409, code: 'ERR_EMAIL_ALREADY_REGISTERED', error: 'A user with this email is already registered' };
    }

    const now = Date.now();
    await db.prepare('DELETE FROM auth.email_registration_codes WHERE expires_at <= ?').run(now);
    const existingCode = await db.prepare('SELECT last_sent_at FROM auth.email_registration_codes WHERE email = ?').get(email);
    const resendCooldownMs = registrationCodeResendCooldownSec * 1000;
    if (existingCode && (now - Number(existingCode.last_sent_at || 0)) < resendCooldownMs) {
      const retryAfterMs = resendCooldownMs - (now - Number(existingCode.last_sent_at || 0));
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      return {
        status: 429,
        code: 'ERR_REGISTRATION_RETRY_LATER',
        error: `Retry will be available in ${retryAfterSec} seconds`,
        headers: { 'Retry-After': String(retryAfterSec) }
      };
    }

    const code = generateRegistrationCode();
    const verifyToken = generateRegistrationVerifyToken();
    const confirmUrl = appendLocaleParam(`${baseUrl}/account/?registerToken=${encodeURIComponent(verifyToken)}`, locale);
    const expiresAt = now + (registrationCodeTtlMinutes * 60 * 1000);
    const codeHash = hashRegistrationCode(sessionSecret, email, code);
    const verifyTokenHash = hashRegistrationVerifyToken(sessionSecret, verifyToken);
    const passwordHash = hashPassword(password);
    await db.prepare(`
      INSERT INTO auth.email_registration_codes (email, code_hash, expires_at, attempts, last_sent_at, created_at, password_hash, first_name, last_name, verify_token_hash)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempts = 0,
        last_sent_at = excluded.last_sent_at,
        created_at = excluded.created_at,
        password_hash = excluded.password_hash,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        verify_token_hash = excluded.verify_token_hash
    `).run(email, codeHash, expiresAt, now, now, passwordHash, firstName, lastName, verifyTokenHash);

    try {
      await sendRegistrationCodeEmail({ to: email, code, expiresInMinutes: registrationCodeTtlMinutes, confirmUrl, locale });
    } catch (error) {
      logger.error('auth_registration_code_send_failed', { email, error: String(error.message || error) });
      return { status: 502, code: 'ERR_REGISTRATION_EMAIL_SEND_FAILED', error: 'Failed to send registration confirmation email' };
    }

    return {
      payload: {
        ok: true,
        expiresInMinutes: registrationCodeTtlMinutes
      }
    };
  }

  async function confirmRegistrationCode(req) {
    if (!resolveRegistrationEnabled()) {
      return { status: 403, code: 'ERR_REGISTRATION_DISABLED', error: 'Registration is disabled' };
    }

    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    if (!isValidEmail(email)) {
      return { status: 400, code: 'ERR_INVALID_EMAIL', error: 'Provide a valid email' };
    }
    if (!/^\d{6}$/.test(code)) {
      return { status: 400, code: 'ERR_CONFIRMATION_CODE_FORMAT', error: 'Confirmation code must contain 6 digits' };
    }

    const existingUser = await db.prepare('SELECT id FROM auth.users WHERE email = ?').get(email);
    if (existingUser) {
      return { status: 409, code: 'ERR_EMAIL_ALREADY_REGISTERED', error: 'A user with this email is already registered' };
    }

    const codeRow = await db.prepare(`
      SELECT email, code_hash, expires_at, attempts, password_hash, first_name, last_name
      FROM auth.email_registration_codes
      WHERE email = ?
    `).get(email);

    if (!codeRow) {
      return { status: 400, code: 'ERR_REGISTRATION_NOT_STARTED', error: 'Submit the registration form first' };
    }

    const now = Date.now();
    if (Number(codeRow.expires_at || 0) <= now) {
      await db.prepare('DELETE FROM auth.email_registration_codes WHERE email = ?').run(email);
      return { status: 400, code: 'ERR_CONFIRMATION_CODE_EXPIRED', error: 'Confirmation code has expired. Submit the form again' };
    }
    if (Number(codeRow.attempts || 0) >= registrationCodeMaxAttempts) {
      return { status: 429, code: 'ERR_CONFIRMATION_ATTEMPTS_EXCEEDED', error: 'Maximum number of attempts exceeded. Submit the form again' };
    }

    const expectedHash = hashRegistrationCode(sessionSecret, email, code);
    if (expectedHash !== String(codeRow.code_hash || '')) {
      await db.prepare('UPDATE auth.email_registration_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
      return { status: 400, code: 'ERR_CONFIRMATION_CODE_INVALID', error: 'Invalid confirmation code' };
    }

    const done = await completeRegistration(codeRow);
    if (done.error) {
      return done;
    }
    let authSession;
    try {
      authSession = await establishAuthenticatedSession(req, done.payload.user);
    } catch (error) {
      logger.error('auth_registration_code_session_failed', { error: String(error.message || error) });
      return { status: 500, code: 'ERR_SESSION_CREATE_FAILED', error: 'Failed to create session' };
    }
    return {
      payload: {
        ok: true,
        user: authSession.user,
        csrfToken: authSession.csrfToken
      }
    };
  }

  async function confirmRegistrationLink(req) {
    if (!resolveRegistrationEnabled()) {
      return { status: 403, code: 'ERR_REGISTRATION_DISABLED', error: 'Registration is disabled' };
    }

    const token = String(req.body?.token || '').trim();
    if (token.length < 32) {
      return { status: 400, code: 'ERR_CONFIRMATION_TOKEN_INVALID', error: 'Invalid confirmation token' };
    }

    const tokenHash = hashRegistrationVerifyToken(sessionSecret, token);
    const row = await db.prepare(`
      SELECT email, password_hash, first_name, last_name, expires_at
      FROM auth.email_registration_codes
      WHERE verify_token_hash = ?
      LIMIT 1
    `).get(tokenHash);
    if (!row) {
      return { status: 400, code: 'ERR_CONFIRMATION_LINK_INVALID', error: 'Confirmation link is invalid or expired' };
    }
    if (Number(row.expires_at || 0) <= Date.now()) {
      await db.prepare('DELETE FROM auth.email_registration_codes WHERE email = ?').run(row.email);
      return { status: 400, code: 'ERR_CONFIRMATION_LINK_INVALID', error: 'Confirmation link is invalid or expired' };
    }

    const done = await completeRegistration(row);
    if (done.error) {
      return done;
    }
    let authSession;
    try {
      authSession = await establishAuthenticatedSession(req, done.payload.user);
    } catch (error) {
      logger.error('auth_registration_link_session_failed', { error: String(error.message || error) });
      return { status: 500, code: 'ERR_SESSION_CREATE_FAILED', error: 'Failed to create session' };
    }
    return {
      payload: {
        ok: true,
        user: authSession.user,
        csrfToken: authSession.csrfToken
      }
    };
  }

  async function logout(req) {
    if (!req?.session || typeof req.session.destroy !== 'function') {
      return { payload: { ok: true } };
    }
    await new Promise<void>((resolve) => {
      req.session.destroy(() => resolve());
    });
    return { payload: { ok: true } };
  }

  async function changePassword(req) {
    if (!req.session?.user) {
      return { status: 401, code: 'ERR_AUTH_REQUIRED', error: 'Authentication is required' };
    }

    const email = normalizeEmail(req.session.user.email);
    if (!isValidEmail(email)) {
      return { status: 400, code: 'ERR_CURRENT_USER_UNRESOLVED', error: 'Failed to resolve the current user email' };
    }

    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (!currentPassword || !newPassword) {
      return { status: 400, code: 'ERR_PASSWORD_CHANGE_FIELDS_REQUIRED', error: 'Provide both current and new password' };
    }
    if (newPassword.length < registrationMinPasswordLength) {
      return { status: 400, code: 'ERR_PASSWORD_TOO_SHORT', error: `New password must be at least ${registrationMinPasswordLength} characters long` };
    }
    if (currentPassword === newPassword) {
      return { status: 400, code: 'ERR_PASSWORD_CHANGE_SAME', error: 'New password must be different from the current password' };
    }

    const user = await db.prepare('SELECT id, password_hash FROM auth.users WHERE email = ?').get(email);
    if (!user) {
      return { status: 404, code: 'ERR_USER_NOT_FOUND', error: 'User not found' };
    }
    if (!verifyPassword(currentPassword, user.password_hash)) {
      return { status: 400, code: 'ERR_CURRENT_PASSWORD_INVALID', error: 'Current password is incorrect' };
    }

    const passwordHash = hashPassword(newPassword);
    await db.prepare('UPDATE auth.users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
    sessionUserCache.delete(email);
    return { payload: { ok: true } };
  }

  async function requestPasswordReset(req) {
    if (!isEmailDeliveryConfigured()) {
      return { status: 503, code: 'ERR_EMAIL_DELIVERY_NOT_CONFIGURED', error: 'Email delivery is not configured on the server' };
    }

    const locale = resolveEmailLocale({ req, locale: req.body?.locale });
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return { payload: { ok: true } };
    }

    const user = await db.prepare('SELECT id FROM auth.users WHERE email = ?').get(email);
    if (!user) {
      return { payload: { ok: true } };
    }

    const baseUrl = resolveAppBaseUrl(req);
    if (!baseUrl) {
      return { status: 500, code: 'ERR_APP_BASE_URL_UNAVAILABLE', error: 'Failed to resolve app base URL for the reset link' };
    }

    const now = Date.now();
    await db.prepare('DELETE FROM auth.password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL').run(now);
    await db.prepare('DELETE FROM auth.password_reset_tokens WHERE email = ?').run(email);

    const token = generatePasswordResetToken();
    const tokenHash = hashPasswordResetToken(sessionSecret, token);
    const expiresAt = now + (passwordResetTtlMinutes * 60 * 1000);
    await db.prepare(`
      INSERT INTO auth.password_reset_tokens (token_hash, email, expires_at, created_at, used_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run(tokenHash, email, expiresAt, now);

    const resetUrl = appendLocaleParam(`${baseUrl}/?resetToken=${encodeURIComponent(token)}`, locale);
    try {
      await sendPasswordResetEmail({ to: email, resetUrl, expiresInMinutes: passwordResetTtlMinutes, locale });
    } catch (error) {
      logger.error('auth_password_reset_send_failed', { email, error: String(error.message || error) });
      return { status: 502, code: 'ERR_PASSWORD_RESET_EMAIL_SEND_FAILED', error: 'Failed to send password reset email' };
    }

    return { payload: { ok: true } };
  }

  async function confirmPasswordReset(req) {
    const token = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    if (token.length < 32) {
      return { status: 400, code: 'ERR_PASSWORD_RESET_TOKEN_INVALID', error: 'Invalid password reset token' };
    }
    if (newPassword.length < registrationMinPasswordLength) {
      return { status: 400, code: 'ERR_PASSWORD_TOO_SHORT', error: `New password must be at least ${registrationMinPasswordLength} characters long` };
    }

    const tokenHash = hashPasswordResetToken(sessionSecret, token);
    const now = Date.now();
    const resetRow = await db.prepare(`
      SELECT token_hash, email, expires_at, used_at
      FROM auth.password_reset_tokens
      WHERE token_hash = ?
      LIMIT 1
    `).get(tokenHash);

    if (!resetRow || Number(resetRow.used_at || 0) > 0 || Number(resetRow.expires_at || 0) <= now) {
      return { status: 400, code: 'ERR_PASSWORD_RESET_LINK_INVALID', error: 'Password reset link is invalid or expired' };
    }

    const user = await db.prepare('SELECT id FROM auth.users WHERE email = ?').get(resetRow.email);
    if (!user) {
      return { status: 404, code: 'ERR_USER_NOT_FOUND', error: 'User not found' };
    }

    const passwordHash = hashPassword(newPassword);
    const tx = db.transaction(async () => {
      await db.prepare('UPDATE auth.users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
      await db.prepare('UPDATE auth.password_reset_tokens SET used_at = ? WHERE token_hash = ?').run(now, tokenHash);
      await db.prepare('DELETE FROM auth.password_reset_tokens WHERE email = ? AND token_hash <> ?').run(resetRow.email, tokenHash);
    });
    await tx();

    return { payload: { ok: true } };
  }

  return {
    changePassword,
    confirmPasswordReset,
    confirmRegistrationCode,
    confirmRegistrationLink,
    getCurrentSessionPayload,
    isValidEmail,
    login,
    logout,
    normalizeEmail,
    normalizeProfileName,
    requestPasswordReset,
    requireAdminSession,
    requireMasterAdminSession,
    resolveSessionUser,
    startRegistration
  };
}

module.exports = {
  createAuthService
};
