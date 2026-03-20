function requireCsrfSession(req, res, next) {
  if (!req?.session?.user) return next();
  const expected = String(req.session.csrfToken || '');
  const provided = String(req.get('x-csrf-token') || '');
  if (!expected || !provided || expected !== provided) {
    return res.status(403).json({ code: 'ERR_CSRF_INVALID', error: 'CSRF token missing or invalid' });
  }
  return next();
}

module.exports = {
  requireCsrfSession
};
