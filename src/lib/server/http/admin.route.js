const { sendCachedJson } = require('../infra/http-cache.infra');
const { sendMailWithFallback } = require('../services/smtp-transport.service');

function registerAdminRoutes(deps) {
  const {
    app,
    db,
    adminApiRateLimiter,
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
    getOsmContourRow,
    reassignUserEdit,
    deleteUserEdit,
    enqueueSearchIndexRefresh,
    ARCHI_FIELD_SET,
    registrationCodeHtmlTemplate,
    registrationCodeTextTemplate,
    passwordResetHtmlTemplate,
    passwordResetTextTemplate,
    appSettingsService,
    dataSettingsService,
    getAllFilterTagKeysCached,
    applyFilterTagAllowlistSnapshot,
    onGeneralSettingsSaved,
    onSmtpSettingsSaved,
    onDataRegionsSaved,
    onRegionSyncRequested,
    appDisplayName,
    getAppDisplayName,
    appBaseUrl,
    getAppBaseUrl,
    registrationCodeTtlMinutes,
    passwordResetTtlMinutes
  } = deps;

  function resolveAppDisplayName() {
    if (typeof getAppDisplayName === 'function') {
      return String(getAppDisplayName() || 'archimap').trim() || 'archimap';
    }
    return String(appDisplayName || 'archimap').trim() || 'archimap';
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
    const v = Math.trunc(n);
    return Math.max(min, Math.min(max, v));
  }

  function parseRegionId(raw) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return null;
    return id;
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

  app.use('/api/admin', adminApiRateLimiter);
  app.use('/api/ui/email-previews', adminApiRateLimiter);

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

    return sendCachedJson(req, res, {
      appDisplayName: currentAppDisplayName,
      generatedAt: new Date().toISOString(),
      templates: {
        registration,
        passwordReset
      }
    }, {
      cacheControl: 'private, no-cache'
    });
  });

  app.get('/api/admin/app-settings/smtp', requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    if (!appSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек недоступен' });
    }
    return sendCachedJson(req, res, {
      ok: true,
      item: await appSettingsService.getSmtpSettingsForAdmin()
    }, {
      cacheControl: 'private, no-cache'
    });
  });

  app.get('/api/admin/app-settings/general', requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    if (!appSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек недоступен' });
    }
    return sendCachedJson(req, res, {
      ok: true,
      item: await appSettingsService.getGeneralSettingsForAdmin()
    }, {
      cacheControl: 'private, no-cache'
    });
  });

  app.post('/api/admin/app-settings/general', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    if (!appSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек недоступен' });
    }
    const general = req.body?.general && typeof req.body.general === 'object' ? req.body.general : {};
    const actor = getSessionEditActorKey(req) || 'admin';
    const saved = await appSettingsService.saveGeneralSettings(general, actor);
    if (typeof onGeneralSettingsSaved === 'function') {
      onGeneralSettingsSaved(saved);
    }
    return res.json({
      ok: true,
      item: saved
    });
  });

  app.post('/api/admin/app-settings/smtp', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    if (!appSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек недоступен' });
    }
    const smtp = req.body?.smtp && typeof req.body.smtp === 'object' ? req.body.smtp : {};
    const actor = getSessionEditActorKey(req) || 'admin';
    const saved = await appSettingsService.saveSmtpSettings(smtp, actor);
    if (typeof onSmtpSettingsSaved === 'function') {
      onSmtpSettingsSaved(saved);
    }
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
    const testEmail = String(req.body?.testEmail || '').trim().toLowerCase();
    if (!isLikelyEmail(testEmail)) {
      return res.status(400).json({ error: 'Укажите корректный email для тестового письма' });
    }
    const keepPassword = smtp.keepPassword !== false;
    const candidate = await appSettingsService.buildSmtpConfigFromInput(smtp, { keepPassword });
    if (!candidate.from) {
      return res.status(400).json({ error: 'Для отправки тестового письма укажите поле From' });
    }

    const effectiveAppDisplayName = resolveAppDisplayName();
    const subject = `${effectiveAppDisplayName}: SMTP test`;
    const nowIso = new Date().toISOString();
    const text = [
      `Это тестовое письмо от ${effectiveAppDisplayName}.`,
      '',
      `Дата: ${nowIso}`,
      `Host: ${candidate.host || '(from SMTP URL)'}`,
      `Port: ${candidate.port || '(from SMTP URL)'}`,
      `Secure: ${candidate.secure ? 'true' : 'false'}`
    ].join('\n');

    if (!candidate.url && (!candidate.host || !candidate.port || !candidate.user || !candidate.pass || !candidate.from)) {
      return res.status(400).json({ error: 'Для тестовой отправки нужны host/port/user/password/from или smtp url' });
    }

    try {
      await sendMailWithFallback(candidate, {
        from: candidate.from,
        to: testEmail,
        subject,
        text
      }, {
        logContext: { flow: 'admin_smtp_test', to: '[REDACTED]' }
      });
      return res.json({ ok: true, message: `Тестовое письмо отправлено на ${testEmail}` });
    } catch (error) {
      return res.status(400).json({ error: `SMTP test send failed: ${String(error?.message || error)}` });
    }
  });

  app.get('/api/admin/app-settings/data', requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    if (!dataSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек данных недоступен' });
    }
    const base = await dataSettingsService.getDataSettingsForAdmin();
    const availableKeys = typeof getAllFilterTagKeysCached === 'function'
      ? await getAllFilterTagKeysCached()
      : [];
    return sendCachedJson(req, res, {
      ok: true,
      item: {
        ...base,
        filterTags: {
          ...(base.filterTags || {}),
          availableKeys
        }
      }
    }, {
      cacheControl: 'private, no-cache'
    });
  });

  app.post('/api/admin/app-settings/data/filter-tag-allowlist', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    if (!dataSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек данных недоступен' });
    }
    try {
      const allowlist = Array.isArray(req.body?.allowlist) ? req.body.allowlist : [];
      const actor = getSessionEditActorKey(req) || 'admin';
      const saved = await dataSettingsService.saveFilterTagAllowlist(allowlist, actor);
      if (typeof applyFilterTagAllowlistSnapshot === 'function') {
        applyFilterTagAllowlistSnapshot(saved);
      }
      return res.json({
        ok: true,
        item: saved
      });
    } catch (error) {
      return res.status(400).json({ error: String(error?.message || error || 'Не удалось сохранить allowlist тегов') });
    }
  });

  app.get('/api/admin/app-settings/data/regions', requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    if (!dataSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек данных недоступен' });
    }
    const includeDisabled = String(req.query?.includeDisabled ?? 'true').trim().toLowerCase() !== 'false';
    const items = await dataSettingsService.listRegions({
      includeDisabled,
      includeStorageStats: true
    });
    return sendCachedJson(req, res, {
      ok: true,
      items
    }, {
      cacheControl: 'private, no-cache'
    });
  });

  app.post('/api/admin/app-settings/data/regions/resolve-extract', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    if (!dataSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек данных недоступен' });
    }
    try {
      const query = String(req.body?.query || '').trim();
      const source = String(req.body?.source || 'any').trim() || 'any';
      const resolved = await dataSettingsService.searchExtractCandidates(query, {
        source,
        limit: 12
      });
      return res.json({
        ok: true,
        query: resolved.query,
        items: resolved.items
      });
    } catch (error) {
      return res.status(400).json({ error: String(error?.message || error || 'Не удалось подобрать extract-кандидатов') });
    }
  });

  app.get('/api/admin/app-settings/data/regions/:regionId/runs', requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    if (!dataSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек данных недоступен' });
    }
    const regionId = parseRegionId(req.params.regionId);
    if (!regionId) {
      return res.status(400).json({ error: 'Некорректный идентификатор региона' });
    }
    const limit = parseLimit(req.query?.limit, 20, 1, 200);
    const region = await dataSettingsService.getRegionById(regionId);
    if (!region) {
      return res.status(404).json({ error: 'Регион не найден' });
    }
    const items = await dataSettingsService.getRecentRuns(regionId, limit);
    return sendCachedJson(req, res, {
      ok: true,
      region,
      items
    }, {
      cacheControl: 'private, no-cache'
    });
  });

  app.post('/api/admin/app-settings/data/regions', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    if (!dataSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек данных недоступен' });
    }
    try {
      const region = req.body?.region && typeof req.body.region === 'object' ? req.body.region : {};
      const actor = getSessionEditActorKey(req) || 'admin';
      const previous = region?.id ? await dataSettingsService.getRegionById(region.id) : null;
      const saved = await dataSettingsService.saveRegion(region, actor);
      if (typeof onDataRegionsSaved === 'function') {
        await Promise.resolve(onDataRegionsSaved({
          action: 'save',
          saved,
          previous
        }));
      }
      return res.json({
        ok: true,
        item: saved
      });
    } catch (error) {
      return res.status(400).json({ error: String(error?.message || error || 'Не удалось сохранить регион') });
    }
  });

  app.delete('/api/admin/app-settings/data/regions/:regionId', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    if (!dataSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек данных недоступен' });
    }
    const regionId = parseRegionId(req.params.regionId);
    if (!regionId) {
      return res.status(400).json({ error: 'Некорректный идентификатор региона' });
    }
    try {
      const actor = getSessionEditActorKey(req) || 'admin';
      const deleted = await dataSettingsService.deleteRegion(regionId, actor);
      if (typeof onDataRegionsSaved === 'function') {
        await Promise.resolve(onDataRegionsSaved({
          action: 'delete',
          deleted
        }));
      }
      return res.json({
        ok: true,
        item: deleted
      });
    } catch (error) {
      return res.status(400).json({ error: String(error?.message || error || 'Не удалось удалить регион') });
    }
  });

  app.post('/api/admin/app-settings/data/regions/:regionId/sync-now', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    if (!dataSettingsService) {
      return res.status(500).json({ error: 'Сервис настроек данных недоступен' });
    }
    if (typeof onRegionSyncRequested !== 'function') {
      return res.status(503).json({ error: 'Очередь синхронизации пока недоступна' });
    }
    const regionId = parseRegionId(req.params.regionId);
    if (!regionId) {
      return res.status(400).json({ error: 'Некорректный идентификатор региона' });
    }
    try {
      const requestedBy = getSessionEditActorKey(req) || 'admin';
      const result = await onRegionSyncRequested(regionId, {
        triggerReason: 'manual',
        requestedBy
      });
      return res.json({
        ok: true,
        item: result
      });
    } catch (error) {
      return res.status(400).json({ error: String(error?.message || error || 'Не удалось поставить регион в очередь синхронизации') });
    }
  });

  app.get(/^\/ui(?:\/.*)?$/, requireAuth, requireAdmin, (req, res) => {
    return res.redirect('/admin');
  });

  app.get('/api/admin/building-edits', requireAuth, requireAdmin, async (req, res) => {
    const statusRaw = String(req.query?.status || '').trim().toLowerCase();
    const status = statusRaw === 'all' || !statusRaw ? null : normalizeUserEditStatus(statusRaw);
    const limit = parseLimit(req.query?.limit, 200, 1, 1000);
    const out = await getUserEditsList({ status, limit, summary: false });
    return sendCachedJson(req, res, {
      total: out.length,
      items: out
    }, {
      cacheControl: 'private, no-cache'
    });
  });

  app.get('/api/admin/building-edits/:editId', requireAuth, requireAdmin, async (req, res) => {
    const editId = Number(req.params.editId);
    if (!Number.isInteger(editId) || editId <= 0) {
      return res.status(400).json({ error: 'Некорректный идентификатор правки' });
    }
    const item = await getUserEditDetailsById(editId);
    if (!item) {
      return res.status(404).json({ error: 'Правка не найдена' });
    }
    return sendCachedJson(req, res, { item }, {
      cacheControl: 'private, no-cache',
      lastModified: item.updatedAt || undefined
    });
  });

  app.get('/api/admin/users/:email', requireAuth, requireAdmin, async (req, res) => {
    const email = String(req.params.email || '').trim().toLowerCase();
    if (!isLikelyEmail(email)) {
      return res.status(400).json({ error: 'Некорректный email' });
    }
    const row = await db.prepare(`
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
    return sendCachedJson(req, res, {
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
    }, {
      cacheControl: 'private, no-cache',
      lastModified: row.last_edit_at || row.created_at || undefined
    });
  });

  app.get('/api/admin/users/:email/edits', requireAuth, requireAdmin, async (req, res) => {
    const email = String(req.params.email || '').trim().toLowerCase();
    if (!isLikelyEmail(email)) {
      return res.status(400).json({ error: 'Некорректный email' });
    }
    const limit = parseLimit(req.query?.limit, 200, 1, 1000);
    const items = await getUserEditsList({ createdBy: email, limit, summary: true });
    return sendCachedJson(req, res, { total: items.length, items }, {
      cacheControl: 'private, no-cache'
    });
  });

  app.post('/api/admin/building-edits/:editId/reject', requireCsrfSession, requireAuth, requireAdmin, async (req, res) => {
    const editId = Number(req.params.editId);
    if (!Number.isInteger(editId) || editId <= 0) {
      return res.status(400).json({ error: 'Некорректный идентификатор правки' });
    }
    const row = await getUserEditDetailsById(editId);
    if (!row) return res.status(404).json({ error: 'Правка не найдена' });
    if (normalizeUserEditStatus(row.status) !== 'pending') {
      return res.status(409).json({ error: 'Правка уже обработана' });
    }
    const comment = sanitizeFieldText(req.body?.comment, 1200);
    const reviewer = getSessionEditActorKey(req) || 'admin';
    const result = await db.prepare(`
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

  app.post('/api/admin/building-edits/:editId/reassign', requireCsrfSession, requireAuth, requireAdmin, async (req, res) => {
    const editId = Number(req.params.editId);
    if (!Number.isInteger(editId) || editId <= 0) {
      return res.status(400).json({ error: 'Некорректный идентификатор правки' });
    }

    const target = parseOsmTarget(req.body?.target);
    if (!target) {
      return res.status(400).json({ error: 'Укажите корректный идентификатор целевого здания' });
    }

    const before = await getUserEditDetailsById(editId);
    if (!before) {
      return res.status(404).json({ error: 'Правка не найдена' });
    }

    const actor = getSessionEditActorKey(req) || 'admin';
    const force = Boolean(req.body?.force === true);
    try {
      const updated = await reassignUserEdit(editId, target, { actor, force });
      if (before.osmType && Number.isInteger(Number(before.osmId))) {
        enqueueSearchIndexRefresh(before.osmType, before.osmId);
      }
      if (updated?.osmType && Number.isInteger(Number(updated.osmId))) {
        enqueueSearchIndexRefresh(updated.osmType, updated.osmId);
      }
      return res.json({
        ok: true,
        item: updated
      });
    } catch (error) {
      const message = String(error?.message || error || 'Не удалось переназначить правку');
      if (message.includes('не найдена')) {
        return res.status(404).json({ error: message });
      }
      if (message.includes('конфликтующие локальные поля')) {
        return res.status(409).json({ error: message, code: 'REASSIGN_TARGET_CONFLICT' });
      }
      return res.status(400).json({ error: message });
    }
  });

  app.delete('/api/admin/building-edits/:editId', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, async (req, res) => {
    const editId = Number(req.params.editId);
    if (!Number.isInteger(editId) || editId <= 0) {
      return res.status(400).json({ error: 'Некорректный идентификатор правки' });
    }

    try {
      const deleted = await deleteUserEdit(editId);
      if (deleted?.osmType && Number.isInteger(Number(deleted.osmId))) {
        enqueueSearchIndexRefresh(deleted.osmType, deleted.osmId);
      }
      return res.json({
        ok: true,
        item: deleted
      });
    } catch (error) {
      const message = String(error?.message || error || 'Не удалось удалить правку');
      if (error?.code === 'EDIT_NOT_FOUND' || message.includes('не найдена')) {
        return res.status(404).json({ error: message });
      }
      if (error?.code === 'EDIT_DELETE_SHARED_MERGED_STATE') {
        return res.status(409).json({ error: message, code: error.code });
      }
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/admin/building-edits/:editId/merge', requireCsrfSession, requireAuth, requireAdmin, async (req, res) => {
    const editId = Number(req.params.editId);
    if (!Number.isInteger(editId) || editId <= 0) {
      return res.status(400).json({ error: 'Некорректный идентификатор правки' });
    }
    const item = await getUserEditDetailsById(editId);
    if (!item) {
      return res.status(404).json({ error: 'Правка не найдена' });
    }
    if (normalizeUserEditStatus(item.status) !== 'pending') {
      return res.status(409).json({ error: 'Правка уже обработана' });
    }
    const forceMerge = Boolean(req.body?.force === true);
    const currentContour = await getOsmContourRow(item.osmType, item.osmId);
    if (!currentContour) {
      return res.status(409).json({
        error: 'Исходное OSM-здание больше не существует в локальной базе контуров. Сначала переназначьте правку на актуальное здание.',
        code: 'EDIT_TARGET_MISSING'
      });
    }
    if (!forceMerge && item.sourceOsmChanged) {
      return res.status(409).json({
        error: 'Правка устарела: OSM-данные здания изменились после её создания. Обновите правку, переназначьте её или выполните merge с force.',
        code: 'EDIT_OUTDATED_OSM',
        currentUpdatedAt: item.currentOsmUpdatedAt || null,
        sourceUpdatedAt: item.sourceOsmUpdatedAt || null
      });
    }

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

    const currentMerged = await getMergedInfoRow(item.osmType, item.osmId) || {};
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
    const editSource = await db.prepare(`
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

    const tx = db.transaction(async () => {
      await db.prepare(`
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

      await db.prepare(`
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
      await tx();
    } catch {
      return res.status(409).json({ error: 'Не удалось применить merge: правка была изменена параллельно' });
    }
    const updated = await db.prepare('SELECT status FROM user_edits.building_user_edits WHERE id = ?').get(editId);
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
