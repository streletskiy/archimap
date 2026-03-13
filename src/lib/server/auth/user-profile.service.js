function createUserProfileService({
  db,
  normalizeEmail,
  isValidEmail,
  normalizeProfileName
}) {
  async function updateCurrentProfile(req) {
    if (!req.session?.user) {
      return { status: 401, code: 'ERR_AUTH_REQUIRED', error: 'Authentication is required' };
    }
    const email = normalizeEmail(req.session.user.email);
    if (!isValidEmail(email)) {
      return { status: 400, code: 'ERR_CURRENT_USER_UNRESOLVED', error: 'Failed to resolve the current user email' };
    }

    const firstName = normalizeProfileName(req.body?.firstName);
    const lastName = normalizeProfileName(req.body?.lastName);
    await db.prepare('UPDATE auth.users SET first_name = ?, last_name = ? WHERE email = ?').run(firstName, lastName, email);
    req.session.user.firstName = firstName;
    req.session.user.lastName = lastName;
    return {
      payload: {
        ok: true,
        user: { ...req.session.user }
      }
    };
  }

  async function updateUserEditPermission(body = {}) {
    const email = normalizeEmail(body?.email);
    const canEdit = Boolean(body?.canEdit);
    if (!isValidEmail(email)) {
      return { status: 400, code: 'ERR_INVALID_EMAIL', error: 'Provide a valid user email' };
    }

    const result = await db.prepare('UPDATE auth.users SET can_edit = ? WHERE email = ?').run(canEdit ? 1 : 0, email);
    if (Number(result?.changes || 0) === 0) {
      return { status: 404, code: 'ERR_USER_NOT_FOUND', error: 'User not found' };
    }

    return {
      payload: {
        ok: true,
        email,
        canEdit
      }
    };
  }

  async function listUsers(query = {}) {
    const q = String(query?.q || '').trim().toLowerCase();
    const sortByRaw = String(query?.sortBy || '').trim();
    const sortDirRaw = String(query?.sortDir || '').trim().toLowerCase();
    const roleFilter = String(query?.role || '').trim().toLowerCase();
    const canEditFilter = String(query?.canEdit || '').trim().toLowerCase();
    const hasEditsFilter = String(query?.hasEdits || '').trim().toLowerCase();

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

    const rows = await db.prepare(`
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

    return {
      payload: {
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
      }
    };
  }

  async function updateUserRole(body = {}) {
    const email = normalizeEmail(body?.email);
    const isAdmin = Boolean(body?.isAdmin);
    if (!isValidEmail(email)) {
      return { status: 400, code: 'ERR_INVALID_EMAIL', error: 'Provide a valid user email' };
    }

    const target = await db.prepare('SELECT is_master_admin FROM auth.users WHERE email = ?').get(email);
    if (!target) {
      return { status: 404, code: 'ERR_USER_NOT_FOUND', error: 'User not found' };
    }
    const targetIsMasterAdmin = Number(target?.is_master_admin || 0) > 0;
    if (targetIsMasterAdmin && !isAdmin) {
      return { status: 403, code: 'ERR_MASTER_ADMIN_DEMOTION_FORBIDDEN', error: 'A master admin cannot be demoted to a regular user' };
    }

    await db.prepare('UPDATE auth.users SET is_admin = ? WHERE email = ?').run(isAdmin ? 1 : 0, email);

    return {
      payload: {
        ok: true,
        email,
        isAdmin
      }
    };
  }

  return {
    listUsers,
    updateCurrentProfile,
    updateUserEditPermission,
    updateUserRole
  };
}

module.exports = {
  createUserProfileService
};
