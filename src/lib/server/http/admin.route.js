const { sendCachedJson } = require('../infra/http-cache.infra');
const { createAdminSettingsService } = require('../services/admin/admin-settings.service');
const { createAdminEditsService } = require('../services/admin/admin-edits.service');
const { requireMasterAdmin } = require('../services/admin/shared');

function sendPrivateJson(req, res, payload, lastModified) {
  const cacheOptions = {
    cacheControl: 'private, no-cache'
  };
  if (lastModified) {
    cacheOptions.lastModified = lastModified;
  }
  return sendCachedJson(req, res, payload, cacheOptions);
}

function sendAdminError(res, error, fallbackStatus = 500, fallbackMessage = 'Запрос администратора завершился ошибкой') {
  const status = Number(error?.status) || fallbackStatus;
  const payload = {
    error: String(error?.message || fallbackMessage)
  };
  if (error?.code) {
    payload.code = error.code;
  }
  if (error?.details && typeof error.details === 'object') {
    Object.assign(payload, error.details);
  }
  return res.status(status).json(payload);
}

function withAdminError(handler, fallback = {}) {
  return async function adminRouteHandler(req, res) {
    try {
      return await handler(req, res);
    } catch (error) {
      return sendAdminError(res, error, fallback.status, fallback.message);
    }
  };
}

function registerAdminRoutes(deps) {
  const {
    app,
    adminApiRateLimiter,
    requireAuth,
    requireAdmin,
    requireCsrfSession,
    getSessionEditActorKey
  } = deps;

  // Route file stays focused on HTTP wiring while the admin domain lives in dedicated services.
  const adminSettingsService = createAdminSettingsService(deps);
  const adminEditsService = createAdminEditsService(deps);

  app.use('/api/admin', adminApiRateLimiter);
  app.use('/api/ui/email-previews', adminApiRateLimiter);

  app.get('/api/ui/email-previews', requireAuth, requireAdmin, withAdminError(async (req, res) => {
    return sendPrivateJson(req, res, await adminSettingsService.buildEmailPreviewPayload());
  }));

  app.get('/api/admin/app-settings/smtp', requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return sendPrivateJson(req, res, {
      ok: true,
      item: await adminSettingsService.getSmtpSettingsItem()
    });
  }, {
    status: 500,
    message: 'Сервис настроек недоступен'
  }));

  app.get('/api/admin/app-settings/general', requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return sendPrivateJson(req, res, {
      ok: true,
      item: await adminSettingsService.getGeneralSettingsItem()
    });
  }, {
    status: 500,
    message: 'Сервис настроек недоступен'
  }));

  app.post('/api/admin/app-settings/general', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.saveGeneralSettings(req.body?.general, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'Сервис настроек недоступен'
  }));

  app.post('/api/admin/app-settings/smtp', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.saveSmtpSettings(req.body?.smtp, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'Сервис настроек недоступен'
  }));

  app.post('/api/admin/app-settings/smtp/test', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json(await adminSettingsService.sendSmtpTest({
      smtp: req.body?.smtp,
      testEmail: req.body?.testEmail
    }));
  }, {
    status: 500,
    message: 'Сервис настроек недоступен'
  }));

  app.get('/api/admin/app-settings/data', requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return sendPrivateJson(req, res, {
      ok: true,
      item: await adminSettingsService.getDataSettingsItem()
    });
  }, {
    status: 500,
    message: 'Сервис настроек данных недоступен'
  }));

  app.post('/api/admin/app-settings/data/filter-tag-allowlist', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.saveFilterTagAllowlist(req.body?.allowlist, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'Сервис настроек данных недоступен'
  }));

  app.get('/api/admin/app-settings/data/regions', requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return sendPrivateJson(req, res, {
      ok: true,
      items: await adminSettingsService.listRegions(req.query?.includeDisabled)
    });
  }, {
    status: 500,
    message: 'Сервис настроек данных недоступен'
  }));

  app.post('/api/admin/app-settings/data/regions/resolve-extract', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    const resolved = await adminSettingsService.resolveExtractCandidates({
      query: req.body?.query,
      source: req.body?.source
    });
    return res.json({
      ok: true,
      query: resolved.query,
      items: resolved.items
    });
  }, {
    status: 500,
    message: 'Сервис настроек данных недоступен'
  }));

  app.get('/api/admin/app-settings/data/regions/:regionId/runs', requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    const result = await adminSettingsService.getRegionRuns(req.params.regionId, req.query?.limit);
    return sendPrivateJson(req, res, {
      ok: true,
      region: result.region,
      items: result.items
    });
  }, {
    status: 500,
    message: 'Сервис настроек данных недоступен'
  }));

  app.post('/api/admin/app-settings/data/regions', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.saveRegion(req.body?.region, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'Сервис настроек данных недоступен'
  }));

  app.delete('/api/admin/app-settings/data/regions/:regionId', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.deleteRegion(req.params.regionId, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'Сервис настроек данных недоступен'
  }));

  app.post('/api/admin/app-settings/data/regions/:regionId/sync-now', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.requestRegionSync(req.params.regionId, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'Сервис настроек данных недоступен'
  }));

  app.get(/^\/ui(?:\/.*)?$/, requireAuth, requireAdmin, (req, res) => {
    return res.redirect('/admin');
  });

  app.get('/api/admin/building-edits', requireAuth, requireAdmin, withAdminError(async (req, res) => {
    const items = await adminEditsService.listBuildingEdits({
      status: req.query?.status,
      limit: req.query?.limit
    });
    return sendPrivateJson(req, res, {
      total: items.length,
      items
    });
  }));

  app.get('/api/admin/building-edits/:editId', requireAuth, requireAdmin, withAdminError(async (req, res) => {
    const item = await adminEditsService.getBuildingEditDetails(req.params.editId);
    return sendPrivateJson(req, res, { item }, item.updatedAt || undefined);
  }));

  app.get('/api/admin/users/:email', requireAuth, requireAdmin, withAdminError(async (req, res) => {
    const result = await adminEditsService.getUserByEmail(req.params.email);
    return sendPrivateJson(req, res, { item: result.item }, result.lastModified);
  }));

  app.get('/api/admin/users/:email/edits', requireAuth, requireAdmin, withAdminError(async (req, res) => {
    const items = await adminEditsService.getUserEditsByEmail(req.params.email, req.query?.limit);
    return sendPrivateJson(req, res, {
      total: items.length,
      items
    });
  }));

  app.post('/api/admin/building-edits/:editId/reject', requireCsrfSession, requireAuth, requireAdmin, withAdminError(async (req, res) => {
    return res.json(await adminEditsService.rejectBuildingEdit(req.params.editId, {
      comment: req.body?.comment,
      reviewer: getSessionEditActorKey(req) || 'admin'
    }));
  }));

  app.post('/api/admin/building-edits/:editId/reassign', requireCsrfSession, requireAuth, requireAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminEditsService.reassignBuildingEdit(req.params.editId, {
        target: req.body?.target,
        actor: getSessionEditActorKey(req) || 'admin',
        force: req.body?.force
      })
    });
  }));

  app.delete('/api/admin/building-edits/:editId', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminEditsService.deleteBuildingEdit(req.params.editId)
    });
  }));

  app.post('/api/admin/building-edits/:editId/merge', requireCsrfSession, requireAuth, requireAdmin, withAdminError(async (req, res) => {
    return res.json(await adminEditsService.mergeBuildingEdit(req.params.editId, {
      force: req.body?.force,
      fields: req.body?.fields,
      values: req.body?.values,
      comment: req.body?.comment,
      reviewer: getSessionEditActorKey(req) || 'admin'
    }));
  }));
}

module.exports = {
  registerAdminRoutes
};
