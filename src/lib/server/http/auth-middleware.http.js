function createAuthMiddlewareSupport(options = {}) {
  const {
    db,
    getUserEditRequiresPermission = () => true
  } = options;

  if (!db) {
    throw new Error('createAuthMiddlewareSupport: db is required');
  }

  async function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }
    const email = String(req.session.user.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }
    const row = await db.prepare('SELECT email, can_edit, is_admin, is_master_admin, first_name, last_name FROM auth.users WHERE email = ?').get(email);
    if (!row) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }
    const isMasterAdmin = Number(row.is_master_admin || 0) > 0;
    const isAdmin = isMasterAdmin || Number(row.is_admin || 0) > 0;
    const canEdit = Number(row.can_edit || 0) > 0;
    req.session.user = {
      ...req.session.user,
      username: String(row.email || req.session.user.username || ''),
      email: String(row.email || req.session.user.email || ''),
      isAdmin,
      isMasterAdmin,
      canEdit,
      canEditBuildings: isAdmin ? true : (getUserEditRequiresPermission() ? canEdit : true),
      firstName: row.first_name == null ? null : String(row.first_name),
      lastName: row.last_name == null ? null : String(row.last_name)
    };
    return next();
  }

  function isAdminRequest(req) {
    return Boolean(req.session?.user?.isAdmin);
  }

  function requireAdmin(req, res, next) {
    if (!req?.session?.user) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }
    if (!isAdminRequest(req)) {
      return res.status(403).json({ error: 'Требуются права администратора' });
    }
    return next();
  }

  async function requireBuildingEditPermission(req, res, next) {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }

    if (isAdminRequest(req)) return next();
    if (!getUserEditRequiresPermission()) return next();

    const email = String(req.session.user.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(403).json({ error: 'Редактирование недоступно для этой учетной записи' });
    }

    const row = await db.prepare('SELECT can_edit, is_admin FROM auth.users WHERE email = ?').get(email);
    if (!row) {
      return res.status(403).json({ error: 'Редактирование недоступно для этой учетной записи' });
    }
    if (Number(row.is_admin || 0) > 0) return next();
    if (Number(row.can_edit || 0) <= 0) {
      return res.status(403).json({ error: 'Редактирование запрещено. Обратитесь к администратору за доступом.' });
    }

    return next();
  }

  return {
    requireAuth,
    requireAdmin,
    requireBuildingEditPermission,
    isAdminRequest
  };
}

module.exports = {
  createAuthMiddlewareSupport
};
