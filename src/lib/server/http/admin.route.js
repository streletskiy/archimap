const { sendCachedJson } = require('../infra/http-cache.infra');
const { createAdminSettingsService } = require('../services/admin/admin-settings.service');
const { createAdminEditsService } = require('../services/admin/admin-edits.service');
const { createOsmSyncService } = require('../services/osm-sync.service');
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

function sendAdminError(res, error, fallbackStatus = 500, fallbackMessage = 'Admin request failed') {
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
  const osmSyncService = createOsmSyncService(deps);
  const styleRegionOverridesService = deps.styleRegionOverridesService;

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
    message: 'Settings service is unavailable'
  }));

  app.get('/api/admin/app-settings/general', requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return sendPrivateJson(req, res, {
      ok: true,
      item: await adminSettingsService.getGeneralSettingsItem()
    });
  }, {
    status: 500,
    message: 'Settings service is unavailable'
  }));

  app.post('/api/admin/app-settings/general', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.saveGeneralSettings(req.body?.general, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'Settings service is unavailable'
  }));

  app.post('/api/admin/app-settings/smtp', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.saveSmtpSettings(req.body?.smtp, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'Settings service is unavailable'
  }));

  app.post('/api/admin/app-settings/smtp/test', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json(await adminSettingsService.sendSmtpTest({
      smtp: req.body?.smtp,
      testEmail: req.body?.testEmail
    }));
  }, {
    status: 500,
    message: 'Settings service is unavailable'
  }));

  app.get('/api/admin/app-settings/data', requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return sendPrivateJson(req, res, {
      ok: true,
      item: await adminSettingsService.getDataSettingsItem()
    });
  }, {
    status: 500,
    message: 'Data settings service is unavailable'
  }));

  app.post('/api/admin/app-settings/data/filter-tag-allowlist', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.saveFilterTagAllowlist(req.body?.allowlist, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'Data settings service is unavailable'
  }));

  app.get('/api/admin/app-settings/data/filter-presets', requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    const result = await adminSettingsService.listFilterPresets();
    return sendPrivateJson(req, res, {
      ok: true,
      source: result?.source || 'db',
      items: Array.isArray(result?.items) ? result.items : []
    });
  }, {
    status: 500,
    message: 'Data settings service is unavailable'
  }));

  app.post('/api/admin/app-settings/data/filter-presets', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.saveFilterPreset(req.body?.preset, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'Data settings service is unavailable'
  }));

  app.delete('/api/admin/app-settings/data/filter-presets/:id', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.deleteFilterPreset(req.params.id)
    });
  }, {
    status: 500,
    message: 'Data settings service is unavailable'
  }));

  app.get('/api/admin/app-settings/data/regions', requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return sendPrivateJson(req, res, {
      ok: true,
      items: await adminSettingsService.listRegions(req.query?.includeDisabled)
    });
  }, {
    status: 500,
    message: 'Data settings service is unavailable'
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
    message: 'Data settings service is unavailable'
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
    message: 'Data settings service is unavailable'
  }));

  app.post('/api/admin/app-settings/data/regions', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.saveRegion(req.body?.region, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'Data settings service is unavailable'
  }));

  app.delete('/api/admin/app-settings/data/regions/:regionId', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.deleteRegion(req.params.regionId, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'Data settings service is unavailable'
  }));

  app.post('/api/admin/app-settings/data/regions/:regionId/sync-now', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await adminSettingsService.requestRegionSync(req.params.regionId, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'Data settings service is unavailable'
  }));

  app.get('/api/admin/app-settings/osm', requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return sendPrivateJson(req, res, {
      ok: true,
      item: await osmSyncService.getSettingsForAdmin()
    });
  }, {
    status: 500,
    message: 'OSM sync service is unavailable'
  }));

  app.post('/api/admin/app-settings/osm', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await osmSyncService.saveSettings(req.body?.osm, getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'OSM sync service is unavailable'
  }));

  app.post('/api/admin/app-settings/osm/oauth/start', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await osmSyncService.startOAuth(getSessionEditActorKey(req) || 'admin')
    });
  }, {
    status: 500,
    message: 'OSM sync service is unavailable'
  }));

  app.get('/api/admin/app-settings/osm/oauth/callback', requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    const result = await osmSyncService.handleOauthCallback({
      code: req.query?.code,
      state: req.query?.state
    });
    const message = encodeURIComponent('osm-connected');
    const user = encodeURIComponent(result?.osm?.connectedUser || '');
    return res.redirect(`/admin/osm?osmSync=${message}${user ? `&user=${user}` : ''}`);
  }, {
    status: 500,
    message: 'OSM OAuth callback failed'
  }));

  app.get('/api/admin/osm-sync/candidates', requireAuth, requireAdmin, withAdminError(async (req, res) => {
    const items = await osmSyncService.listSyncCandidates(req.query?.limit);
    return sendPrivateJson(req, res, {
      total: items.length,
      items
    });
  }, {
    status: 500,
    message: 'OSM sync service is unavailable'
  }));

  app.post('/api/admin/osm-sync/candidates/sync', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    return res.json({
      ok: true,
      item: await osmSyncService.syncCandidatesToOsm(
        items,
        getSessionEditActorKey(req) || 'admin'
      )
    });
  }, {
    status: 500,
    message: 'OSM sync service is unavailable'
  }));

  app.get('/api/admin/osm-sync/candidates/:osmType/:osmId', requireAuth, requireAdmin, withAdminError(async (req, res) => {
    const item = await osmSyncService.getSyncCandidate(req.params.osmType, req.params.osmId);
    if (!item) {
      return res.status(404).json({ error: 'Sync candidate not found' });
    }
    return sendPrivateJson(req, res, { item }, item.latestUpdatedAt || undefined);
  }, {
    status: 500,
    message: 'OSM sync service is unavailable'
  }));

  app.post('/api/admin/osm-sync/candidates/:osmType/:osmId/sync', requireCsrfSession, requireAuth, requireAdmin, requireMasterAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await osmSyncService.syncCandidateToOsm(
        req.params.osmType,
        req.params.osmId,
        getSessionEditActorKey(req) || 'admin'
      )
    });
  }, {
    status: 500,
    message: 'OSM sync service is unavailable'
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

  app.get('/api/admin/style-overrides', requireAuth, requireAdmin, withAdminError(async (req, res) => {
    return sendPrivateJson(req, res, {
      ok: true,
      items: await styleRegionOverridesService.listOverridesForAdmin()
    });
  }));

  app.post('/api/admin/style-overrides', requireCsrfSession, requireAuth, requireAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await styleRegionOverridesService.saveOverride(req.body?.override, getSessionEditActorKey(req) || 'admin')
    });
  }));

  app.delete('/api/admin/style-overrides/:id', requireCsrfSession, requireAuth, requireAdmin, withAdminError(async (req, res) => {
    return res.json({
      ok: true,
      item: await styleRegionOverridesService.deleteOverride(req.params.id)
    });
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
