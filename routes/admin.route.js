const nodemailer = require('nodemailer');

function registerAdminRoutes(deps) {
  const {
    app,
    db,
    requireAuth,
    requireAdmin,
    requireCsrfSession,
    getUserEditsList,
    getUserEditDetailsById,
    getSessionEditActorKey,
    normalizeUserEditStatus,
    sanitizeFieldText,
    sanitizeYearBuilt,
    sanitizeLevels,
    getMergedInfoRow,
    enqueueSearchIndexRefresh,
    ARCHI_FIELD_SET,
    registrationCodeHtmlTemplate,
    registrationCodeTextTemplate,
    passwordResetHtmlTemplate,
    passwordResetTextTemplate,
    appSettingsService,
    appDisplayName,
    getAppDisplayName,
    appBaseUrl,
    getAppBaseUrl,
    registrationCodeTtlMinutes,
    passwordResetTtlMinutes
  } = deps;

  function resolveAppDisplayName() {
    if (typeof getAppDisplayName === 'function') {
      return String(getAppDisplayName() || 'Archimap').trim() || 'Archimap';
    }
    return String(appDisplayName || 'Archimap').trim() || 'Archimap';
  }

  function resolveAppBaseUrl() {
    if (typeof getAppBaseUrl === 'function') {
      return String(getAppBaseUrl() || '').trim();
    }
    return String(appBaseUrl || '').trim();
  }

  function requireMasterAdmin(req, res, next) {
    if (!req?.session?.user) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }
    if (!req.session.user.isMasterAdmin) {
      return res.status(403).json({ error: 'Требуются права master admin' });
    }
    return next();
  }

  app.get('/api/ui/email-previews', requireAuth, requireAdmin, (req, res) => {
    const currentAppDisplayName = resolveAppDisplayName();
    const currentAppBaseUrl = resolveAppBaseUrl();
    const sample = {
      registration: {
        code: '583401',
        expiresInMinutes: registrationCodeTtlMinutes,
        confirmUrl: `${currentAppBaseUrl || 'https://archimap.local'}/account/?registerToken=sample-token-ui-preview`
      },
      passwordReset: {
        expiresInMinutes: passwordResetTtlMinutes,
        resetUrl: `${currentAppBaseUrl || 'https://archimap.local'}/?auth=1&reset=sample-reset-token`
      }
    };

    const registration = {
      subject: `${currentAppDisplayName}: код подтверждения регистрации`,
      html: registrationCodeHtmlTemplate({
        code: sample.registration.code,
        expiresInMinutes: sample.registration.expiresInMinutes,
        appDisplayName: currentAppDisplayName,
        confirmUrl: sample.registration.confirmUrl
      }),
      text: registrationCodeTextTemplate({
        code: sample.registration.code,
        expiresInMinutes: sample.registration.expiresInMinutes,
        appDisplayName: currentAppDisplayName,
        confirmUrl: sample.registration.confirmUrl
      })
    };

    const passwordReset = {
      subject: `${currentAppDisplayName}: сброс пароля`,
      html: passwordResetHtmlTemplate({
        resetUrl: sample.passwordReset.resetUrl,
        expiresInMinutes: sample.passwordReset.expiresInMinutes,
        appDisplayName: currentAppDisplayName
      }),
      text: passwordResetTextTemplate({
        resetUrl: sample.passwordReset.resetUrl,
        expiresInMinutes: sample.passwordReset.expiresInMinutes,
        appDisplayName: currentAppDisplayName
      })
    };

    return res.json({
      appDisplayName: currentAppDisplayName,
      generatedAt: new Date().toISOString(),
      templates: {
        registration,
        passwordReset
      }
    });
  });

  app.get('/api/admin/app-settings/smtp', requireAuth, requireAdmin, requireMasterAdmin, (req, res) => {
    if (!appSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек недоступен' });
    }
    return res.json({
      ok: true,
      item: appSettingsService.getSmtpSettingsForAdmin()
    });
  });

  app.get('/api/admin/app-settings/general', requireAuth, requireAdmin, requireMasterAdmin, (req, res) => {
    if (!appSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек недоступен' });
    }
    return res.json({
      ok: true,
      item: appSettingsService.getGeneralSettingsForAdmin()
    });
  });

  app.post('/api/admin/app-settings/general', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, (req, res) => {
    if (!appSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек недоступен' });
    }
    const general = req.body?.general && typeof req.body.general === 'object' ? req.body.general : {};
    const actor = getSessionEditActorKey(req) || 'admin';
    const saved = appSettingsService.saveGeneralSettings(general, actor);
    return res.json({
      ok: true,
      item: saved
    });
  });

  app.post('/api/admin/app-settings/smtp', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, (req, res) => {
    if (!appSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек недоступен' });
    }
    const smtp = req.body?.smtp && typeof req.body.smtp === 'object' ? req.body.smtp : {};
    const actor = getSessionEditActorKey(req) || 'admin';
    const saved = appSettingsService.saveSmtpSettings(smtp, actor);
    return res.json({
      ok: true,
      item: saved
    });
  });

  app.post('/api/admin/app-settings/smtp/test', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    if (!appSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек недоступен' });
    }
    const smtp = req.body?.smtp && typeof req.body.smtp === 'object' ? req.body.smtp : {};
    const keepPassword = smtp.keepPassword !== false;
    const candidate = appSettingsService.buildSmtpConfigFromInput(smtp, { keepPassword });

    if (candidate.url) {
      try {
        const transporter = nodemailer.createTransport(candidate.url);
        await transporter.verify();
      } catch (error) {
        return res.status(400).json({ error: `SMTP verify failed: ${String(error?.message || error)}` });
      }
      return res.json({ ok: true, message: 'SMTP URL проверен успешно' });
    }

    if (!candidate.host || !candidate.port || !candidate.user || !candidate.pass || !candidate.from) {
      return res.status(400).json({ error: 'Для проверки нужны host/port/user/password/from или smtp url' });
    }

    try {
      const transporter = nodemailer.createTransport({
        host: candidate.host,
        port: candidate.port,
        secure: candidate.secure,
        auth: {
          user: candidate.user,
          pass: candidate.pass
        }
      });
      await transporter.verify();
      return res.json({ ok: true, message: 'SMTP проверен успешно' });
    } catch (error) {
      return res.status(400).json({ error: `SMTP verify failed: ${String(error?.message || error)}` });
    }
  });

  app.get(/^\/ui(?:\/.*)?$/, requireAuth, requireAdmin, (req, res) => {
    return res.redirect('/admin/?tab=uikit');
  });

  app.get('/api/admin/building-edits', requireAuth, requireAdmin, (req, res) => {
    const statusRaw = String(req.query?.status || '').trim().toLowerCase();
    const status = statusRaw === 'all' || !statusRaw ? null : normalizeUserEditStatus(statusRaw);
    const out = getUserEditsList({ status, limit: 5000 });
    return res.json({
      total: out.length,
      items: out
    });
  });

  app.get('/api/admin/building-edits/:editId', requireAuth, requireAdmin, (req, res) => {
    const editId = Number(req.params.editId);
    if (!Number.isInteger(editId) || editId <= 0) {
      return res.status(400).json({ error: 'Некорректный идентификатор правки' });
    }
    const item = getUserEditDetailsById(editId);
    if (!item) {
      return res.status(404).json({ error: 'Правка не найдена' });
    }
    return res.json({ item });
  });

  app.get('/api/admin/users/:email', requireAuth, requireAdmin, (req, res) => {
    const email = String(req.params.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Некорректный email' });
    }
    const row = db.prepare(`
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
      WHERE lower(u.email) = ?
      LIMIT 1
    `).get(email);
    if (!row) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    return res.json({
      item: {
        email: String(row.email || ''),
        firstName: row.first_name == null ? null : String(row.first_name),
        lastName: row.last_name == null ? null : String(row.last_name),
        canEdit: Number(row.can_edit || 0) > 0,
        isAdmin: Number(row.is_master_admin || 0) > 0 || Number(row.is_admin || 0) > 0,
        isMasterAdmin: Number(row.is_master_admin || 0) > 0,
        createdAt: String(row.created_at || ''),
        editsCount: Number(row.edits_count || 0),
        lastEditAt: row.last_edit_at ? String(row.last_edit_at) : null
      }
    });
  });

  app.get('/api/admin/users/:email/edits', requireAuth, requireAdmin, (req, res) => {
    const email = String(req.params.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Некорректный email' });
    }
    const items = getUserEditsList({ createdBy: email, limit: 5000 });
    return res.json({ total: items.length, items });
  });

  app.post('/api/admin/building-edits/:editId/reject', requireCsrfSession, requireAuth, requireAdmin, (req, res) => {
    const editId = Number(req.params.editId);
    if (!Number.isInteger(editId) || editId <= 0) {
      return res.status(400).json({ error: 'Некорректный идентификатор правки' });
    }
    const row = getUserEditDetailsById(editId);
    if (!row) return res.status(404).json({ error: 'Правка не найдена' });
    if (normalizeUserEditStatus(row.status) !== 'pending') {
      return res.status(409).json({ error: 'Правка уже обработана' });
    }
    const comment = sanitizeFieldText(req.body?.comment, 1200);
    const reviewer = getSessionEditActorKey(req) || 'admin';
    const result = db.prepare(`
      UPDATE user_edits.building_user_edits
      SET
        status = 'rejected',
        admin_comment = ?,
        reviewed_by = ?,
        reviewed_at = datetime('now'),
        merged_by = NULL,
        merged_at = NULL,
        merged_fields_json = NULL,
        updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(comment, reviewer, editId);
    if (Number(result?.changes || 0) === 0) {
      return res.status(409).json({ error: 'Правка уже обработана другим администратором' });
    }
    return res.json({ ok: true, editId, status: 'rejected' });
  });

  app.post('/api/admin/building-edits/:editId/merge', requireCsrfSession, requireAuth, requireAdmin, (req, res) => {
    const editId = Number(req.params.editId);
    if (!Number.isInteger(editId) || editId <= 0) {
      return res.status(400).json({ error: 'Некорректный идентификатор правки' });
    }
    const item = getUserEditDetailsById(editId);
    if (!item) {
      return res.status(404).json({ error: 'Правка не найдена' });
    }
    if (normalizeUserEditStatus(item.status) !== 'pending') {
      return res.status(409).json({ error: 'Правка уже обработана' });
    }
    const forceMerge = Boolean(req.body?.force === true);

    const allowedFields = new Set(item.changes.map((change) => String(change.field || '')));
    if (allowedFields.size === 0) {
      return res.status(409).json({ error: 'В правке нет отличий от текущих данных' });
    }

    const requestedFields = Array.isArray(req.body?.fields)
      ? req.body.fields.map((value) => String(value || '').trim()).filter((key) => ARCHI_FIELD_SET.has(key) && allowedFields.has(key))
      : [];
    const fieldsToMerge = requestedFields.length > 0 ? [...new Set(requestedFields)] : [...allowedFields];

    const valuesRaw = req.body?.values && typeof req.body.values === 'object' ? req.body.values : {};
    const sanitizedValues = {};
    for (const key of fieldsToMerge) {
      if (!Object.prototype.hasOwnProperty.call(valuesRaw, key)) continue;
      if (key === 'year_built') {
        const parsed = sanitizeYearBuilt(valuesRaw[key]);
        if (parsed == null && String(valuesRaw[key] ?? '').trim() !== '') {
          return res.status(400).json({ error: 'Год постройки должен быть целым числом от 1000 до 2100' });
        }
        sanitizedValues[key] = parsed;
        continue;
      }
      if (key === 'levels') {
        const parsed = sanitizeLevels(valuesRaw[key]);
        if (parsed == null && String(valuesRaw[key] ?? '').trim() !== '') {
          return res.status(400).json({ error: 'Этажность должна быть целым числом от 0 до 300' });
        }
        sanitizedValues[key] = parsed;
        continue;
      }
      sanitizedValues[key] = sanitizeFieldText(valuesRaw[key], key === 'archimap_description' ? 1000 : 300);
    }

    const currentMerged = getMergedInfoRow(item.osmType, item.osmId) || {};
    const editCreatedTs = item.createdAt ? Date.parse(String(item.createdAt)) : NaN;
    const currentMergedTs = currentMerged?.updated_at ? Date.parse(String(currentMerged.updated_at)) : NaN;
    if (!forceMerge && Number.isFinite(editCreatedTs) && Number.isFinite(currentMergedTs) && currentMergedTs > editCreatedTs) {
      return res.status(409).json({
        error: 'Правка устарела: данные здания были изменены после её создания. Обновите правку или выполните merge с force.',
        code: 'EDIT_OUTDATED',
        currentUpdatedAt: currentMerged.updated_at || null,
        editCreatedAt: item.createdAt || null
      });
    }
    const editSource = db.prepare(`
      SELECT name, style, levels, year_built, architect, address, archimap_description
      FROM user_edits.building_user_edits
      WHERE id = ?
      LIMIT 1
    `).get(editId) || {};

    const mergedCandidate = {
      name: currentMerged.name ?? null,
      style: currentMerged.style ?? null,
      levels: currentMerged.levels ?? null,
      year_built: currentMerged.year_built ?? null,
      architect: currentMerged.architect ?? null,
      address: currentMerged.address ?? null,
      archimap_description: currentMerged.archimap_description ?? null
    };
    for (const field of fieldsToMerge) {
      mergedCandidate[field] = Object.prototype.hasOwnProperty.call(sanitizedValues, field)
        ? sanitizedValues[field]
        : (editSource[field] ?? null);
    }

    const reviewer = getSessionEditActorKey(req) || 'admin';
    const adminComment = sanitizeFieldText(req.body?.comment, 1200);
    const nextStatus = fieldsToMerge.length < allowedFields.size ? 'partially_accepted' : 'accepted';

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO local.architectural_info (
          osm_type, osm_id, name, style, levels, year_built, architect, address, archimap_description, updated_by, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(osm_type, osm_id) DO UPDATE SET
          name = excluded.name,
          style = excluded.style,
          levels = excluded.levels,
          year_built = excluded.year_built,
          architect = excluded.architect,
          address = excluded.address,
          archimap_description = excluded.archimap_description,
          updated_by = excluded.updated_by,
          updated_at = datetime('now')
      `).run(
        item.osmType,
        item.osmId,
        mergedCandidate.name,
        mergedCandidate.style,
        mergedCandidate.levels,
        mergedCandidate.year_built,
        mergedCandidate.architect,
        mergedCandidate.address,
        mergedCandidate.archimap_description,
        reviewer
      );

      db.prepare(`
        UPDATE user_edits.building_user_edits
        SET
          status = ?,
          admin_comment = ?,
          reviewed_by = ?,
          reviewed_at = datetime('now'),
          merged_by = ?,
          merged_at = datetime('now'),
          merged_fields_json = ?,
          updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'
      `).run(nextStatus, adminComment, reviewer, reviewer, JSON.stringify(fieldsToMerge), editId);
    });

    try {
      tx();
    } catch {
      return res.status(409).json({ error: 'Не удалось применить merge: правка была изменена параллельно' });
    }
    const updated = db.prepare('SELECT status FROM user_edits.building_user_edits WHERE id = ?').get(editId);
    if (!updated || (normalizeUserEditStatus(updated.status) !== 'accepted' && normalizeUserEditStatus(updated.status) !== 'partially_accepted')) {
      return res.status(409).json({ error: 'Правка уже обработана другим администратором' });
    }
    enqueueSearchIndexRefresh(item.osmType, item.osmId);
    return res.json({
      ok: true,
      editId,
      status: nextStatus,
      mergedFields: fieldsToMerge
    });
  });
}

module.exports = {
  registerAdminRoutes
};
