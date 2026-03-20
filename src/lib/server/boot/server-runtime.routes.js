const { registerAuthRoutes } = require('../auth');
const { requireCsrfSession } = require('../services/csrf.service');
const {
  registrationCodeHtmlTemplate,
  registrationCodeTextTemplate,
  passwordResetHtmlTemplate,
  passwordResetTextTemplate
} = require('../email-templates');
const { registerContoursStatusRoute } = require('../http/contours-status.route');
const { registerAppRoutes } = require('../http/app.route');
const { registerAdminRoutes } = require('../http/admin.route');
const { registerBuildingsRoutes } = require('../http/buildings.route');
const { registerSearchRoutes } = require('../http/search.route');
const { registerAccountRoutes } = require('../http/account.route');

function registerServerRuntimeRoutes(runtime) {
  registerAuthRoutes({
    app: runtime.app,
    db: runtime.db,
    createSimpleRateLimiter: runtime.createSimpleRateLimiter,
    logger: runtime.logger,
    sessionSecret: runtime.config.sessionSecret,
    userEditRequiresPermission: runtime.config.userEditRequiresPermission,
    getUserEditRequiresPermission: runtime.getUserEditRequiresPermission,
    registrationEnabled: runtime.config.registrationEnabled,
    getRegistrationEnabled: runtime.getRegistrationEnabled,
    registrationCodeTtlMinutes: runtime.config.registrationCodeTtlMinutes,
    registrationCodeResendCooldownSec: runtime.config.registrationCodeResendCooldownSec,
    registrationCodeMaxAttempts: runtime.config.registrationCodeMaxAttempts,
    registrationMinPasswordLength: runtime.config.registrationMinPasswordLength,
    passwordResetTtlMinutes: runtime.config.passwordResetTtlMinutes,
    appBaseUrl: runtime.config.appBaseUrl,
    getAppBaseUrl: runtime.getAppBaseUrl,
    appDisplayName: runtime.config.appDisplayName,
    getAppDisplayName: runtime.getAppDisplayName,
    getSmtpConfig: runtime.getEffectiveSmtpConfig
  });

  registerAppRoutes({
    app: runtime.app,
    publicApiRateLimiter: runtime.rateLimiters.publicApiRateLimiter,
    rootDir: runtime.config.rootDir,
    dataDir: runtime.config.paths.dataDir,
    normalizeMapConfig: () => runtime.normalizeMapConfig(),
    getBuildInfo: runtime.getBuildInfo,
    getAppVersion: runtime.getAppVersion,
    registrationEnabled: runtime.config.registrationEnabled,
    getRegistrationEnabled: runtime.getRegistrationEnabled,
    dataSettingsService: runtime.dataSettingsService,
    styleRegionOverridesService: runtime.styleRegionOverridesService,
    getFilterTagKeysCached: runtime.getFilterTagKeysCached,
    getAllFilterTagKeysCached: runtime.getAllFilterTagKeysCached,
    isFilterTagKeysRebuildInProgress: runtime.isFilterTagKeysRebuildInProgress
  });

  registerAdminRoutes({
    app: runtime.app,
    db: runtime.db,
    adminApiRateLimiter: runtime.rateLimiters.adminApiRateLimiter,
    requireAuth: runtime.requireAuth,
    requireAdmin: runtime.requireAdmin,
    requireCsrfSession,
    getUserEditsList: runtime.getUserEditsList,
    getUserEditDetailsById: runtime.getUserEditDetailsById,
    getSessionEditActorKey: runtime.getSessionEditActorKey,
    normalizeUserEditStatus: runtime.normalizeUserEditStatus,
    sanitizeFieldText: runtime.sanitizeFieldText,
    sanitizeYearBuilt: runtime.sanitizeYearBuilt,
    sanitizeLevels: runtime.sanitizeLevels,
    getMergedInfoRow: runtime.getMergedInfoRow,
    getOsmContourRow: runtime.getOsmContourRow,
    reassignUserEdit: runtime.reassignUserEdit,
    deleteUserEdit: runtime.deleteUserEdit,
    enqueueSearchIndexRefresh: runtime.enqueueSearchIndexRefresh,
    ARCHI_FIELD_SET: runtime.ARCHI_FIELD_SET,
    registrationCodeHtmlTemplate,
    registrationCodeTextTemplate,
    passwordResetHtmlTemplate,
    passwordResetTextTemplate,
    appSettingsService: runtime.appSettingsService,
    dataSettingsService: runtime.dataSettingsService,
    getAllFilterTagKeysCached: runtime.getAllFilterTagKeysCached,
    applyFilterTagAllowlistSnapshot: runtime.applyFilterTagAllowlistSnapshot,
    onGeneralSettingsSaved: runtime.applyGeneralSettingsSnapshot,
    onSmtpSettingsSaved: runtime.applySmtpSettingsSnapshot,
    onDataRegionsSaved: async ({ action, saved, previous, deleted } = {}) => {
      if (action === 'save') {
        runtime.migrateRegionPmtilesFile(previous, saved);
      }
      if (action === 'delete') {
        runtime.removeRegionPmtilesFiles(deleted?.region);
        await runtime.rebuildSearchIndex(`region-delete:${deleted?.region?.id || 'unknown'}`);
        runtime.resetFilterTagKeysCache();
        runtime.scheduleFilterTagKeysCacheRebuild(`region-delete:${deleted?.region?.id || 'unknown'}`);
      }
      return runtime.syncWorkers?.reloadSchedules?.();
    },
    onRegionSyncRequested: (regionId, options) => runtime.syncWorkers?.requestRegionSync?.(regionId, options),
    appDisplayName: runtime.config.appDisplayName,
    getAppDisplayName: runtime.getAppDisplayName,
    appBaseUrl: runtime.config.appBaseUrl,
    getAppBaseUrl: runtime.getAppBaseUrl,
    registrationCodeTtlMinutes: runtime.config.registrationCodeTtlMinutes,
    passwordResetTtlMinutes: runtime.config.passwordResetTtlMinutes,
    styleRegionOverridesService: runtime.styleRegionOverridesService
  });

  registerBuildingsRoutes({
    app: runtime.app,
    db: runtime.db,
    rtreeState: runtime.rtreeState,
    buildingsReadRateLimiter: runtime.rateLimiters.buildingsReadRateLimiter,
    buildingsWriteRateLimiter: runtime.rateLimiters.buildingsWriteRateLimiter,
    filterDataRateLimiter: runtime.rateLimiters.filterDataRateLimiter,
    filterDataBboxRateLimiter: runtime.rateLimiters.filterDataBboxRateLimiter,
    filterMatchesRateLimiter: runtime.rateLimiters.filterMatchesRateLimiter,
    requireCsrfSession,
    requireAuth: runtime.requireAuth,
    requireBuildingEditPermission: runtime.requireBuildingEditPermission,
    getSessionEditActorKey: runtime.getSessionEditActorKey,
    applyPersonalEditsToFilterItems: runtime.applyPersonalEditsToFilterItems,
    isFilterTagAllowed: runtime.isFilterTagAllowed,
    rowToFeature: runtime.rowToFeature,
    attachInfoToFeatures: runtime.attachInfoToFeatures,
    applyUserEditRowToInfo: runtime.applyUserEditRowToInfo,
    getMergedInfoRow: runtime.getMergedInfoRow,
    getOsmContourRow: runtime.getOsmContourRow,
    getLatestUserEditRow: runtime.getLatestUserEditRow,
    normalizeUserEditStatus: runtime.normalizeUserEditStatus,
    sanitizeArchiPayload: runtime.sanitizeArchiPayload,
    sanitizeEditedFields: runtime.sanitizeEditedFields,
    supersedePendingUserEdits: runtime.supersedePendingUserEdits
  });

  registerSearchRoutes({
    app: runtime.app,
    searchRateLimiter: runtime.rateLimiters.searchRateLimiter,
    getBuildingSearchResults: (...args) => runtime.getBuildingSearchResults(...args)
  });

  registerAccountRoutes({
    app: runtime.app,
    accountReadRateLimiter: runtime.rateLimiters.accountReadRateLimiter,
    requireAuth: runtime.requireAuth,
    getSessionEditActorKey: runtime.getSessionEditActorKey,
    normalizeUserEditStatus: runtime.normalizeUserEditStatus,
    getUserEditsList: runtime.getUserEditsList,
    getUserEditDetailsById: runtime.getUserEditDetailsById
  });

  registerContoursStatusRoute(runtime.app, runtime.db, runtime.rateLimiters.contoursStatusRateLimiter);
}

module.exports = {
  registerServerRuntimeRoutes
};
