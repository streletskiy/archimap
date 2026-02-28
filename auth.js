const crypto = require('crypto');
const nodemailer = require('nodemailer');
const {
  registrationCodeHtmlTemplate,
  registrationCodeTextTemplate,
  passwordResetHtmlTemplate,
  passwordResetTextTemplate
} = require('./email-templates');

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

function hashRegistrationCode(sessionSecret, email, code) {
  return crypto
    .createHash('sha256')
    .update(`${sessionSecret}:${normalizeEmail(email)}:${String(code || '').trim()}`)
    .digest('hex');
}

function generateRegistrationCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashRegistrationVerifyToken(sessionSecret, token) {
  return crypto
    .createHash('sha256')
    .update(`${sessionSecret}:registration-verify:${String(token || '').trim()}`)
    .digest('hex');
}

function generateRegistrationVerifyToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashPasswordResetToken(sessionSecret, token) {
  return crypto
    .createHash('sha256')
    .update(`${sessionSecret}:password-reset:${String(token || '').trim()}`)
    .digest('hex');
}

function generatePasswordResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

function ensureAuthSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS auth.users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  can_edit INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_master_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth.email_registration_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  password_hash TEXT,
  first_name TEXT,
  last_name TEXT,
  verify_token_hash TEXT
);

CREATE INDEX IF NOT EXISTS auth.idx_email_registration_codes_expires
ON email_registration_codes (expires_at);

CREATE INDEX IF NOT EXISTS auth.idx_email_registration_codes_verify_token
ON email_registration_codes (verify_token_hash);

CREATE TABLE IF NOT EXISTS auth.password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS auth.idx_password_reset_tokens_email
ON password_reset_tokens (email);

CREATE INDEX IF NOT EXISTS auth.idx_password_reset_tokens_expires
ON password_reset_tokens (expires_at);
`);

  const userColumns = db.prepare('PRAGMA auth.table_info(users)').all();
  const hasMasterAdminColumn = userColumns.some((column) => String(column?.name || '').trim() === 'is_master_admin');
  if (!hasMasterAdminColumn) {
    db.exec('ALTER TABLE auth.users ADD COLUMN is_master_admin INTEGER NOT NULL DEFAULT 0;');
  }
}

function registerAuthRoutes({
  app,
  db,
  createSimpleRateLimiter,
  sessionSecret,
  userEditRequiresPermission,
  registrationEnabled,
  registrationCodeTtlMinutes,
  registrationCodeResendCooldownSec,
  registrationCodeMaxAttempts,
  registrationMinPasswordLength,
  passwordResetTtlMinutes,
  appBaseUrl,
  appDisplayName,
  smtp
}) {
  let smtpTransporter = null;

  function ensureCsrfToken(req) {
    if (!req?.session) return null;
    if (!req.session.csrfToken) {
      req.session.csrfToken = generateCsrfToken();
    }
    return String(req.session.csrfToken || '');
  }

  function normalizeProfileName(value, maxLen = 80) {
    const text = String(value || '').trim();
    if (!text) return null;
    return text.slice(0, maxLen);
  }

  async function establishAuthenticatedSession(req, sessionUser) {
    const nextUser = sessionUser && typeof sessionUser === 'object' ? sessionUser : null;
    if (!nextUser) {
      throw new Error('Session user is required');
    }
    if (!req?.session || typeof req.session.regenerate !== 'function') {
      throw new Error('Session is not initialized');
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate((error) => {
        if (error) return reject(error);
        return resolve();
      });
    });

    req.session.user = nextUser;
    const csrfToken = ensureCsrfToken(req);
    return { user: req.session.user, csrfToken };
  }

  function buildSessionUserFromRow(row) {
    const isMasterAdmin = Number(row?.is_master_admin || 0) > 0;
    const isAdmin = isMasterAdmin || Number(row?.is_admin || 0) > 0;
    const canEdit = Number(row?.can_edit || 0) > 0;
    const canEditBuildings = isAdmin ? true : (userEditRequiresPermission ? canEdit : true);
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

  function isMasterAdminSession(req) {
    return Boolean(req?.session?.user?.isMasterAdmin);
  }

  function resolveSessionUser(req) {
    const sessionUser = req?.session?.user;
    if (!sessionUser) return null;

    const email = normalizeEmail(sessionUser.email);
    if (!isValidEmail(email)) return null;
    const row = db.prepare('SELECT email, first_name, last_name, can_edit, is_admin, is_master_admin FROM auth.users WHERE email = ?').get(email);
    if (!row) return null;
    const user = buildSessionUserFromRow(row);
    req.session.user = user;
    return user;
  }

  function requireCsrfSession(req, res, next) {
    if (!req?.session?.user) return next();
    const expected = String(req.session.csrfToken || '');
    const provided = String(req.get('x-csrf-token') || '');
    if (!expected || !provided || expected !== provided) {
      return res.status(403).json({ error: 'CSRF token missing or invalid' });
    }
    return next();
  }

  function requireAdminSession(req, res, next) {
    const user = resolveSessionUser(req);
    if (!user || !user.isAdmin) {
      return res.status(403).json({ error: 'Требуются права администратора' });
    }
    return next();
  }

  function requireMasterAdminSession(req, res, next) {
    const user = resolveSessionUser(req);
    if (!user || !user.isMasterAdmin) {
      return res.status(403).json({ error: 'Требуются права master admin' });
    }
    return next();
  }

  function isEmailDeliveryConfigured() {
    if (smtp.url) return Boolean(smtp.from);
    return Boolean(smtp.host && smtp.port && smtp.user && smtp.pass && smtp.from);
  }

  function getSmtpTransporter() {
    if (smtpTransporter) return smtpTransporter;
    if (smtp.url) {
      smtpTransporter = nodemailer.createTransport(smtp.url);
      return smtpTransporter;
    }
    if (!smtp.host || !smtp.port || !smtp.user || !smtp.pass) {
      throw new Error('SMTP configuration is incomplete');
    }
    smtpTransporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass }
    });
    return smtpTransporter;
  }

  async function sendRegistrationCodeEmail({ to, code, expiresInMinutes, confirmUrl }) {
    const transporter = getSmtpTransporter();
    const mailOptions = {
      from: smtp.from,
      to,
      subject: `${appDisplayName}: код подтверждения регистрации`,
      text: registrationCodeTextTemplate({ code, expiresInMinutes, appDisplayName, confirmUrl }),
      html: registrationCodeHtmlTemplate({ code, expiresInMinutes, appDisplayName, confirmUrl })
    };
    return transporter.sendMail(mailOptions);
  }

  async function sendPasswordResetEmail({ to, resetUrl, expiresInMinutes }) {
    const transporter = getSmtpTransporter();
    const mailOptions = {
      from: smtp.from,
      to,
      subject: `${appDisplayName}: сброс пароля`,
      text: passwordResetTextTemplate({ resetUrl, expiresInMinutes, appDisplayName }),
      html: passwordResetHtmlTemplate({ resetUrl, expiresInMinutes, appDisplayName })
    };
    return transporter.sendMail(mailOptions);
  }

  function resolveAppBaseUrl(req) {
    if (!appBaseUrl) return '';
    return appBaseUrl.replace(/\/+$/, '');
  }

  const loginRateLimiter = createSimpleRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 20,
    message: 'Слишком много попыток входа, попробуйте позже'
  });

  const registrationCodeRequestRateLimiter = createSimpleRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 12,
    message: 'Слишком много запросов кода подтверждения, попробуйте позже'
  });

  const registrationConfirmRateLimiter = createSimpleRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 20,
    message: 'Слишком много попыток подтверждения, попробуйте позже'
  });

  const changePasswordRateLimiter = createSimpleRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 15,
    message: 'Слишком много попыток смены пароля, попробуйте позже'
  });

  const passwordResetRequestRateLimiter = createSimpleRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 12,
    message: 'Слишком много запросов сброса пароля, попробуйте позже'
  });

  const passwordResetConfirmRateLimiter = createSimpleRateLimiter({
    windowMs: 10 * 60 * 1000,
    maxRequests: 20,
    message: 'Слишком много попыток сброса пароля, попробуйте позже'
  });

  app.get('/api/me', (req, res) => {
    const user = resolveSessionUser(req);
    const authenticated = Boolean(user);
    const csrfToken = user ? ensureCsrfToken(req) : null;
    res.json({ authenticated, user, csrfToken });
  });

  app.post('/api/login', loginRateLimiter, async (req, res) => {
    const body = req.body || {};
    const username = String(body.username ?? body.email ?? '').trim();
    const password = String(body.password ?? '');

    const email = normalizeEmail(username);
    if (isValidEmail(email)) {
      const user = db.prepare('SELECT email, password_hash, first_name, last_name, can_edit, is_admin, is_master_admin FROM auth.users WHERE email = ?').get(email);
      if (user && verifyPassword(password, user.password_hash)) {
        let authSession;
        try {
          authSession = await establishAuthenticatedSession(req, buildSessionUserFromRow(user));
        } catch (error) {
          console.error('[auth] failed to establish login session:', error);
          return res.status(500).json({ error: 'Не удалось создать сессию' });
        }
        return res.json({ ok: true, user: authSession.user, csrfToken: authSession.csrfToken });
      }
    }

    return res.status(401).json({ error: 'Неверный логин или пароль' });
  });

  function isFirstUserBootstrapAvailable() {
    const row = db.prepare('SELECT COUNT(*) AS total FROM auth.users').get();
    return Number(row?.total || 0) === 0;
  }

  function completeRegistration(req, row, options = {}) {
    const email = normalizeEmail(row?.email);
    const passwordHash = String(row?.password_hash || '');
    const firstName = normalizeProfileName(row?.first_name);
    const lastName = normalizeProfileName(row?.last_name);
    const makeAdmin = Boolean(options.makeAdmin);
    const makeMasterAdmin = Boolean(options.makeMasterAdmin);
    const allowEdit = Boolean(options.allowEdit || makeAdmin || makeMasterAdmin);
    const deleteRegistrationCode = options.deleteRegistrationCode !== false;
    if (!isValidEmail(email) || !passwordHash) {
      return { ok: false, status: 400, error: 'Данные регистрации повреждены, начните заново' };
    }

    const tx = db.transaction((nextEmail, nextPasswordHash, nextFirstName, nextLastName, nextCanEdit, nextIsAdmin, nextIsMasterAdmin) => {
      db.prepare('INSERT INTO auth.users (email, password_hash, first_name, last_name, can_edit, is_admin, is_master_admin) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(nextEmail, nextPasswordHash, nextFirstName, nextLastName, nextCanEdit ? 1 : 0, nextIsAdmin ? 1 : 0, nextIsMasterAdmin ? 1 : 0);
      if (deleteRegistrationCode) {
        db.prepare('DELETE FROM auth.email_registration_codes WHERE email = ?').run(nextEmail);
      }
    });

    try {
      tx(email, passwordHash, firstName, lastName, allowEdit, makeAdmin, makeMasterAdmin);
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE constraint failed: auth.users.email')) {
        return { ok: false, status: 409, error: 'Пользователь с таким email уже зарегистрирован' };
      }
      throw error;
    }

    const sessionUser = {
      username: email,
      email,
      isAdmin: makeAdmin || makeMasterAdmin,
      isMasterAdmin: makeMasterAdmin,
      canEdit: allowEdit,
      canEditBuildings: (makeAdmin || makeMasterAdmin) ? true : (userEditRequiresPermission ? allowEdit : true),
      firstName: firstName || null,
      lastName: lastName || null
    };
    return { ok: true, user: sessionUser };
  }

  app.post('/api/register/start', registrationCodeRequestRateLimiter, async (req, res) => {
    const bootstrapFirstAdmin = isFirstUserBootstrapAvailable();
    if (!registrationEnabled && !bootstrapFirstAdmin) {
      return res.status(403).json({ error: 'Регистрация отключена' });
    }

    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const firstName = normalizeProfileName(req.body?.firstName);
    const lastName = normalizeProfileName(req.body?.lastName);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Укажите корректный email' });
    }
    if (password.length < registrationMinPasswordLength) {
      return res.status(400).json({ error: `Пароль должен содержать минимум ${registrationMinPasswordLength} символов` });
    }

    if (bootstrapFirstAdmin) {
      const existingUser = db.prepare('SELECT id FROM auth.users WHERE email = ?').get(email);
      if (existingUser) {
        return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован' });
      }
      const done = completeRegistration(req, {
        email,
        password_hash: hashPassword(password),
        first_name: firstName,
        last_name: lastName
      }, {
        makeAdmin: true,
        makeMasterAdmin: true,
        allowEdit: true,
        deleteRegistrationCode: false
      });
      if (!done.ok) {
        return res.status(done.status).json({ error: done.error });
      }
      let authSession;
      try {
        authSession = await establishAuthenticatedSession(req, done.user);
      } catch (error) {
        console.error('[auth] failed to establish bootstrap session:', error);
        return res.status(500).json({ error: 'Не удалось создать сессию' });
      }
      return res.json({
        ok: true,
        user: authSession.user,
        csrfToken: authSession.csrfToken,
        directSignup: true,
        bootstrapAdmin: true
      });
    }

    if (!isEmailDeliveryConfigured()) {
      return res.status(503).json({ error: 'Отправка писем не настроена на сервере' });
    }

    const baseUrl = resolveAppBaseUrl(req);
    if (!baseUrl) {
      return res.status(500).json({ error: 'Не удалось определить адрес приложения для ссылки подтверждения' });
    }

    const existingUser = db.prepare('SELECT id FROM auth.users WHERE email = ?').get(email);
    if (existingUser) {
      return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован' });
    }

    const now = Date.now();
    db.prepare('DELETE FROM auth.email_registration_codes WHERE expires_at <= ?').run(now);
    const existingCode = db.prepare('SELECT last_sent_at FROM auth.email_registration_codes WHERE email = ?').get(email);
    const resendCooldownMs = registrationCodeResendCooldownSec * 1000;
    if (existingCode && (now - Number(existingCode.last_sent_at || 0)) < resendCooldownMs) {
      const retryAfterMs = resendCooldownMs - (now - Number(existingCode.last_sent_at || 0));
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: `Повторная отправка будет доступна через ${retryAfterSec} сек.` });
    }

    const code = generateRegistrationCode();
    const verifyToken = generateRegistrationVerifyToken();
    const confirmUrl = `${baseUrl}/account/?registerToken=${encodeURIComponent(verifyToken)}`;
    const expiresAt = now + (registrationCodeTtlMinutes * 60 * 1000);
    const codeHash = hashRegistrationCode(sessionSecret, email, code);
    const verifyTokenHash = hashRegistrationVerifyToken(sessionSecret, verifyToken);
    const passwordHash = hashPassword(password);
    db.prepare(`
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
      await sendRegistrationCodeEmail({ to: email, code, expiresInMinutes: registrationCodeTtlMinutes, confirmUrl });
    } catch (error) {
      console.error(`[auth] failed to send registration code to ${email}:`, error);
      return res.status(502).json({ error: 'Не удалось отправить письмо с кодом подтверждения' });
    }

    return res.json({ ok: true, expiresInMinutes: registrationCodeTtlMinutes });
  });

  app.post('/api/register/confirm-code', registrationConfirmRateLimiter, async (req, res) => {
    if (!registrationEnabled) {
      return res.status(403).json({ error: 'Регистрация отключена' });
    }

    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Укажите корректный email' });
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Код должен состоять из 6 цифр' });
    }

    const existingUser = db.prepare('SELECT id FROM auth.users WHERE email = ?').get(email);
    if (existingUser) {
      return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован' });
    }

    const codeRow = db.prepare(`
      SELECT email, code_hash, expires_at, attempts, password_hash, first_name, last_name
      FROM auth.email_registration_codes
      WHERE email = ?
    `).get(email);

    if (!codeRow) {
      return res.status(400).json({ error: 'Сначала отправьте форму регистрации' });
    }

    const now = Date.now();
    if (Number(codeRow.expires_at || 0) <= now) {
      db.prepare('DELETE FROM auth.email_registration_codes WHERE email = ?').run(email);
      return res.status(400).json({ error: 'Срок действия кода истек, отправьте форму снова' });
    }
    if (Number(codeRow.attempts || 0) >= registrationCodeMaxAttempts) {
      return res.status(429).json({ error: 'Превышено число попыток, отправьте форму заново' });
    }

    const expectedHash = hashRegistrationCode(sessionSecret, email, code);
    if (expectedHash !== String(codeRow.code_hash || '')) {
      db.prepare('UPDATE auth.email_registration_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
      return res.status(400).json({ error: 'Неверный код подтверждения' });
    }

    const done = completeRegistration(req, codeRow);
    if (!done.ok) {
      return res.status(done.status).json({ error: done.error });
    }
    let authSession;
    try {
      authSession = await establishAuthenticatedSession(req, done.user);
    } catch (error) {
      console.error('[auth] failed to establish registration (code) session:', error);
      return res.status(500).json({ error: 'Не удалось создать сессию' });
    }
    return res.json({ ok: true, user: authSession.user, csrfToken: authSession.csrfToken });
  });

  app.post('/api/register/confirm-link', registrationConfirmRateLimiter, async (req, res) => {
    if (!registrationEnabled) {
      return res.status(403).json({ error: 'Регистрация отключена' });
    }

    const token = String(req.body?.token || '').trim();
    if (token.length < 32) {
      return res.status(400).json({ error: 'Некорректный токен подтверждения' });
    }

    const tokenHash = hashRegistrationVerifyToken(sessionSecret, token);
    const row = db.prepare(`
      SELECT email, password_hash, first_name, last_name, expires_at
      FROM auth.email_registration_codes
      WHERE verify_token_hash = ?
      LIMIT 1
    `).get(tokenHash);
    if (!row) {
      return res.status(400).json({ error: 'Ссылка подтверждения недействительна или истекла' });
    }
    if (Number(row.expires_at || 0) <= Date.now()) {
      db.prepare('DELETE FROM auth.email_registration_codes WHERE email = ?').run(row.email);
      return res.status(400).json({ error: 'Ссылка подтверждения недействительна или истекла' });
    }

    const done = completeRegistration(req, row);
    if (!done.ok) {
      return res.status(done.status).json({ error: done.error });
    }
    let authSession;
    try {
      authSession = await establishAuthenticatedSession(req, done.user);
    } catch (error) {
      console.error('[auth] failed to establish registration (link) session:', error);
      return res.status(500).json({ error: 'Не удалось создать сессию' });
    }
    return res.json({ ok: true, user: authSession.user, csrfToken: authSession.csrfToken });
  });

  app.post('/api/logout', requireCsrfSession, (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  app.post('/api/account/change-password', requireCsrfSession, changePasswordRateLimiter, (req, res) => {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const email = normalizeEmail(req.session.user.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Не удалось определить email текущего пользователя' });
    }

    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Укажите текущий и новый пароль' });
    }
    if (newPassword.length < registrationMinPasswordLength) {
      return res.status(400).json({ error: `Новый пароль должен содержать минимум ${registrationMinPasswordLength} символов` });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'Новый пароль должен отличаться от текущего' });
    }

    const user = db.prepare('SELECT id, password_hash FROM auth.users WHERE email = ?').get(email);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    if (!verifyPassword(currentPassword, user.password_hash)) {
      return res.status(400).json({ error: 'Текущий пароль указан неверно' });
    }

    const passwordHash = hashPassword(newPassword);
    db.prepare('UPDATE auth.users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
    return res.json({ ok: true });
  });

  app.post('/api/password-reset/request', passwordResetRequestRateLimiter, async (req, res) => {
    if (!isEmailDeliveryConfigured()) {
      return res.status(503).json({ error: 'Отправка писем не настроена на сервере' });
    }

    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return res.json({ ok: true });
    }

    const user = db.prepare('SELECT id FROM auth.users WHERE email = ?').get(email);
    if (!user) {
      return res.json({ ok: true });
    }

    const baseUrl = resolveAppBaseUrl(req);
    if (!baseUrl) {
      return res.status(500).json({ error: 'Не удалось определить адрес приложения для ссылки сброса' });
    }

    const now = Date.now();
    db.prepare('DELETE FROM auth.password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL').run(now);
    db.prepare('DELETE FROM auth.password_reset_tokens WHERE email = ?').run(email);

    const token = generatePasswordResetToken();
    const tokenHash = hashPasswordResetToken(sessionSecret, token);
    const expiresAt = now + (passwordResetTtlMinutes * 60 * 1000);
    db.prepare(`
      INSERT INTO auth.password_reset_tokens (token_hash, email, expires_at, created_at, used_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run(tokenHash, email, expiresAt, now);

    const resetUrl = `${baseUrl}/?resetToken=${encodeURIComponent(token)}`;
    try {
      await sendPasswordResetEmail({ to: email, resetUrl, expiresInMinutes: passwordResetTtlMinutes });
    } catch (error) {
      console.error(`[auth] failed to send password reset email to ${email}:`, error);
      return res.status(502).json({ error: 'Не удалось отправить письмо для сброса пароля' });
    }

    return res.json({ ok: true });
  });

  app.post('/api/password-reset/confirm', passwordResetConfirmRateLimiter, (req, res) => {
    const token = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    if (token.length < 32) {
      return res.status(400).json({ error: 'Некорректный токен сброса' });
    }
    if (newPassword.length < registrationMinPasswordLength) {
      return res.status(400).json({ error: `Новый пароль должен содержать минимум ${registrationMinPasswordLength} символов` });
    }

    const tokenHash = hashPasswordResetToken(sessionSecret, token);
    const now = Date.now();
    const resetRow = db.prepare(`
      SELECT token_hash, email, expires_at, used_at
      FROM auth.password_reset_tokens
      WHERE token_hash = ?
      LIMIT 1
    `).get(tokenHash);

    if (!resetRow || Number(resetRow.used_at || 0) > 0 || Number(resetRow.expires_at || 0) <= now) {
      return res.status(400).json({ error: 'Ссылка сброса недействительна или истекла' });
    }

    const user = db.prepare('SELECT id FROM auth.users WHERE email = ?').get(resetRow.email);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const passwordHash = hashPassword(newPassword);
    const tx = db.transaction(() => {
      db.prepare('UPDATE auth.users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
      db.prepare('UPDATE auth.password_reset_tokens SET used_at = ? WHERE token_hash = ?').run(now, tokenHash);
      db.prepare('DELETE FROM auth.password_reset_tokens WHERE email = ? AND token_hash <> ?').run(resetRow.email, tokenHash);
    });
    tx();

    return res.json({ ok: true });
  });

  app.post('/api/account/profile', requireCsrfSession, (req, res) => {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }
    const email = normalizeEmail(req.session.user.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Не удалось определить email текущего пользователя' });
    }

    const firstName = normalizeProfileName(req.body?.firstName);
    const lastName = normalizeProfileName(req.body?.lastName);
    db.prepare('UPDATE auth.users SET first_name = ?, last_name = ? WHERE email = ?').run(firstName, lastName, email);
    req.session.user.firstName = firstName;
    req.session.user.lastName = lastName;
    return res.json({ ok: true, user: { ...req.session.user } });
  });

  app.post('/api/admin/users/edit-permission', requireCsrfSession, requireAdminSession, (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const canEdit = Boolean(req.body?.canEdit);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Укажите корректный email пользователя' });
    }

    const result = db.prepare('UPDATE auth.users SET can_edit = ? WHERE email = ?').run(canEdit ? 1 : 0, email);
    if (Number(result?.changes || 0) === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    return res.json({ ok: true, email, canEdit });
  });

  app.get('/api/admin/users', requireAdminSession, (req, res) => {
    const q = String(req.query?.q || '').trim().toLowerCase();
    const sortByRaw = String(req.query?.sortBy || '').trim();
    const sortDirRaw = String(req.query?.sortDir || '').trim().toLowerCase();
    const roleFilter = String(req.query?.role || '').trim().toLowerCase();
    const canEditFilter = String(req.query?.canEdit || '').trim().toLowerCase();
    const hasEditsFilter = String(req.query?.hasEdits || '').trim().toLowerCase();

    const sortByMap = {
      email: 'u.email',
      firstName: 'u.first_name',
      lastName: 'u.last_name',
      createdAt: 'u.created_at',
      isAdmin: 'CASE WHEN u.is_master_admin = 1 OR u.is_admin = 1 THEN 1 ELSE 0 END',
      canEdit: 'u.can_edit',
      editsCount: 'edits_count',
      lastEditAt: 'last_edit_at'
    };
    const sortBy = Object.prototype.hasOwnProperty.call(sortByMap, sortByRaw) ? sortByRaw : 'createdAt';
    const sortExpr = sortByMap[sortBy];
    const sortDir = sortDirRaw === 'asc' ? 'ASC' : 'DESC';

    const whereClauses = [];
    const params = [];
    if (q) {
      whereClauses.push('(lower(u.email) LIKE ? OR lower(coalesce(u.first_name, \'\')) LIKE ? OR lower(coalesce(u.last_name, \'\')) LIKE ?)');
      const pattern = `%${q}%`;
      params.push(pattern, pattern, pattern);
    }
    if (roleFilter === 'admin') whereClauses.push('(u.is_admin = 1 OR u.is_master_admin = 1)');
    if (roleFilter === 'user') whereClauses.push('(u.is_admin = 0 AND u.is_master_admin = 0)');
    if (canEditFilter === 'true') whereClauses.push('u.can_edit = 1');
    if (canEditFilter === 'false') whereClauses.push('u.can_edit = 0');
    if (hasEditsFilter === 'true') whereClauses.push('COALESCE(e.edit_count, 0) > 0');
    if (hasEditsFilter === 'false') whereClauses.push('COALESCE(e.edit_count, 0) = 0');
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT
        u.email,
        u.first_name,
        u.last_name,
        u.can_edit,
        u.is_admin,
        u.is_master_admin,
        u.created_at,
        COALESCE(e.edit_count, 0) AS edits_count,
        e.last_edit_at
      FROM auth.users u
      LEFT JOIN (
        SELECT
          lower(trim(created_by)) AS created_by_key,
          COUNT(*) AS edit_count,
          MAX(updated_at) AS last_edit_at
        FROM user_edits.building_user_edits
        GROUP BY lower(trim(created_by))
      ) e
        ON e.created_by_key = lower(u.email)
      ${whereSql}
      ORDER BY ${sortExpr} ${sortDir}, u.created_at DESC
      LIMIT 500
    `).all(...params);

    return res.json({
      items: rows.map((row) => ({
        email: String(row.email || ''),
        firstName: normalizeProfileName(row.first_name),
        lastName: normalizeProfileName(row.last_name),
        canEdit: Number(row.can_edit || 0) > 0,
        isAdmin: Number(row.is_master_admin || 0) > 0 || Number(row.is_admin || 0) > 0,
        isMasterAdmin: Number(row.is_master_admin || 0) > 0,
        createdAt: String(row.created_at || ''),
        editsCount: Number(row.edits_count || 0),
        lastEditAt: row.last_edit_at ? String(row.last_edit_at) : null,
        hasEdits: Number(row.edits_count || 0) > 0
      }))
    });
  });

  app.post('/api/admin/users/role', requireCsrfSession, requireMasterAdminSession, (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const isAdmin = Boolean(req.body?.isAdmin);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Укажите корректный email пользователя' });
    }

    const target = db.prepare('SELECT is_master_admin FROM auth.users WHERE email = ?').get(email);
    if (!target) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    const targetIsMasterAdmin = Number(target?.is_master_admin || 0) > 0;
    if (targetIsMasterAdmin && !isAdmin) {
      return res.status(403).json({ error: 'Мастер-админ не может быть понижен до обычного пользователя' });
    }

    db.prepare('UPDATE auth.users SET is_admin = ? WHERE email = ?').run(isAdmin ? 1 : 0, email);

    return res.json({ ok: true, email, isAdmin });
  });
}

module.exports = {
  ensureAuthSchema,
  registerAuthRoutes
};
