const { createRuntimeSettingsCache } = require('../services/runtime-settings-cache.service');
const {
  DEFAULT_CUSTOM_BASEMAP_URL,
  normalizeBasemapApiKey,
  normalizeBasemapProvider,
  normalizeCustomBasemapUrl
} = require('../services/basemap-config');

function createRuntimeSettingsBoot(options: LooseRecord = {}) {
  const {
    appSettingsService,
    dataSettingsService,
    defaults = {},
    filterTags = {}
  } = options;

  if (!appSettingsService || !dataSettingsService) {
    throw new Error('createRuntimeSettingsBoot: appSettingsService and dataSettingsService are required');
  }

  const {
    appDisplayName = 'archimap',
    appBaseUrl = '',
    registrationEnabled = true,
    userEditRequiresPermission = true,
    basemapProvider = 'carto',
    maptilerApiKey = '',
    customBasemapUrl = DEFAULT_CUSTOM_BASEMAP_URL,
    customBasemapApiKey = '',
    smtpUrl = '',
    smtpHost = '',
    smtpPort = 587,
    smtpSecure = false,
    smtpUser = '',
    smtpPass = '',
    emailFrom = ''
  } = defaults;
  const {
    defaultAllowlist = [],
    normalizeFilterTagKeyList
  } = filterTags;

  const generalConfigFallback = {
    appDisplayName,
    appBaseUrl,
    registrationEnabled,
    userEditRequiresPermission,
    basemapProvider,
    maptilerApiKey,
    customBasemapUrl,
    customBasemapApiKey
  };
  const smtpConfigFallback = {
    url: smtpUrl,
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    user: smtpUser,
    pass: smtpPass,
    from: emailFrom
  };

  const generalSettingsCache = createRuntimeSettingsCache({
    fallback: generalConfigFallback,
    load: () => appSettingsService.getEffectiveGeneralConfig(),
    normalize: (config) => ({
      appDisplayName: String(config.appDisplayName || appDisplayName).trim() || appDisplayName,
      appBaseUrl: String(config.appBaseUrl || '').trim(),
      registrationEnabled: Boolean(config.registrationEnabled),
      userEditRequiresPermission: Boolean(config.userEditRequiresPermission),
      basemapProvider: (() => {
        const provider = normalizeBasemapProvider(config.basemapProvider || basemapProvider);
        const nextMaptilerApiKey = normalizeBasemapApiKey(config.maptilerApiKey);
        const nextCustomBasemapUrl = normalizeCustomBasemapUrl(config.customBasemapUrl, customBasemapUrl);
        if (provider === 'maptiler' && !nextMaptilerApiKey) {
          return 'carto';
        }
        if (provider === 'custom' && !nextCustomBasemapUrl) {
          return 'carto';
        }
        return provider;
      })(),
      maptilerApiKey: normalizeBasemapApiKey(config.maptilerApiKey),
      customBasemapUrl: normalizeCustomBasemapUrl(config.customBasemapUrl, customBasemapUrl),
      customBasemapApiKey: normalizeBasemapApiKey(config.customBasemapApiKey)
    })
  });

  const smtpSettingsCache = createRuntimeSettingsCache({
    fallback: smtpConfigFallback,
    load: () => appSettingsService.getEffectiveSmtpConfig(),
    normalize: (config, previous) => ({
      url: String(config.url || '').trim(),
      host: String(config.host || '').trim(),
      port: Number(config.port || smtpPort),
      secure: Boolean(config.secure),
      user: String(config.user || '').trim(),
      pass: config.keepPassword === false
        ? ''
        : String(config.pass || previous.pass || '').trim(),
      from: String(config.from || '').trim()
    })
  });

  const filterTagAllowlistCache = createRuntimeSettingsCache({
    fallback: {
      allowlist: [...defaultAllowlist],
      allowlistSet: new Set(defaultAllowlist)
    },
    load: () => dataSettingsService.getEffectiveFilterTagAllowlistConfig(),
    normalize: (config) => {
      const allowlist = normalizeFilterTagKeyList(config?.allowlist);
      return {
        allowlist,
        allowlistSet: new Set(allowlist)
      };
    },
    selectConfig: (value) => value
  });

  function getEffectiveGeneralConfig() {
    return generalSettingsCache.getValue();
  }

  function getUserEditRequiresPermission() {
    return Boolean(getEffectiveGeneralConfig().userEditRequiresPermission);
  }

  function getRegistrationEnabled() {
    return Boolean(getEffectiveGeneralConfig().registrationEnabled);
  }

  function getAppBaseUrl() {
    return String(getEffectiveGeneralConfig().appBaseUrl || '').trim();
  }

  function getAppDisplayName() {
    return String(getEffectiveGeneralConfig().appDisplayName || 'archimap').trim() || 'archimap';
  }

  function getEffectiveSmtpConfig() {
    return smtpSettingsCache.getValue();
  }

  function getEffectiveFilterTagAllowlist() {
    return filterTagAllowlistCache.getValue();
  }

  function applyGeneralSettingsSnapshot(saved) {
    generalSettingsCache.applySnapshot(saved?.general);
  }

  function applySmtpSettingsSnapshot(saved) {
    smtpSettingsCache.applySnapshot(saved?.smtp);
  }

  function applyFilterTagAllowlistSnapshot(saved) {
    filterTagAllowlistCache.applySnapshot(saved);
  }

  function refreshRuntimeSettings() {
    generalSettingsCache.refresh();
    smtpSettingsCache.refresh();
    filterTagAllowlistCache.refresh();
  }

  return {
    getEffectiveGeneralConfig,
    getUserEditRequiresPermission,
    getRegistrationEnabled,
    getAppBaseUrl,
    getAppDisplayName,
    getEffectiveSmtpConfig,
    getEffectiveFilterTagAllowlist,
    applyGeneralSettingsSnapshot,
    applySmtpSettingsSnapshot,
    applyFilterTagAllowlistSnapshot,
    refreshRuntimeSettings
  };
}

module.exports = {
  createRuntimeSettingsBoot
};
