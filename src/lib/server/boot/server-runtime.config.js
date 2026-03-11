const path = require('path');
const { collectInlineScriptHashesFromFile } = require('../infra/csp.infra');
const { parseRuntimeEnv } = require('../infra/env.infra');

function createServerRuntimeConfig(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..', '..', '..', '..'));
  const rawEnv = options.rawEnv || process.env;
  const processRef = options.processRef || process;
  const runtimeEnv = parseRuntimeEnv(rawEnv);
  const nodeEnv = runtimeEnv.nodeEnv;
  const trustProxy = String(rawEnv.TRUST_PROXY ?? 'false').toLowerCase() === 'true';
  const dataDir = path.join(rootDir, 'data');
  const frontendIndexPath = path.join(rootDir, 'frontend', 'build', 'index.html');

  const sessionCookieSecureRaw = String(rawEnv.SESSION_COOKIE_SECURE || '').trim().toLowerCase();
  const sessionCookieSecure = sessionCookieSecureRaw === 'true'
    ? true
    : (sessionCookieSecureRaw === 'false'
      ? false
      : (nodeEnv === 'production'));

  return {
    rootDir,
    rawEnv,
    processRef,
    runtimeEnv,
    nodeEnv,
    trustProxy,
    dbProvider: runtimeEnv.dbProvider,
    port: runtimeEnv.port,
    host: runtimeEnv.host,
    appBaseUrl: runtimeEnv.appBaseUrl,
    redisUrl: rawEnv.REDIS_URL || 'redis://redis:6379',
    sessionSecret: runtimeEnv.sessionSecret,
    sessionAllowMemoryFallback: String(
      rawEnv.SESSION_ALLOW_MEMORY_FALLBACK ?? (nodeEnv === 'production' ? 'false' : 'true')
    ).toLowerCase() === 'true',
    sessionCookieSecure,
    autoSyncEnabled: String(rawEnv.AUTO_SYNC_ENABLED ?? 'true').toLowerCase() === 'true',
    autoSyncOnStart: String(rawEnv.AUTO_SYNC_ON_START ?? 'true').toLowerCase() === 'true',
    autoSyncIntervalHours: Number(rawEnv.AUTO_SYNC_INTERVAL_HOURS || 168),
    mapDefaultLon: Number(rawEnv.MAP_DEFAULT_LON ?? 44.0059),
    mapDefaultLat: Number(rawEnv.MAP_DEFAULT_LAT ?? 56.3269),
    mapDefaultZoom: Number(rawEnv.MAP_DEFAULT_ZOOM ?? 15),
    buildingsPmtilesSourceLayer: String(rawEnv.BUILDINGS_PMTILES_SOURCE_LAYER || 'buildings').trim() || 'buildings',
    buildingsPmtilesMinZoom: Math.max(0, Math.min(22, Number(rawEnv.BUILDINGS_PMTILES_MIN_ZOOM || 13))),
    buildingsPmtilesMaxZoom: Math.max(
      Math.max(0, Math.min(22, Number(rawEnv.BUILDINGS_PMTILES_MIN_ZOOM || 13))),
      Math.min(22, Number(rawEnv.BUILDINGS_PMTILES_MAX_ZOOM || 16))
    ),
    smtpUrl: String(rawEnv.SMTP_URL || '').trim(),
    smtpHost: String(rawEnv.SMTP_HOST || '').trim(),
    smtpPort: Number(rawEnv.SMTP_PORT || 587),
    smtpSecure: String(rawEnv.SMTP_SECURE || 'false').toLowerCase() === 'true',
    smtpUser: String(rawEnv.SMTP_USER || '').trim(),
    smtpPass: String(rawEnv.SMTP_PASS || '').trim(),
    emailFrom: '',
    appSettingsSecret: '',
    userEditRequiresPermission: String(rawEnv.USER_EDIT_REQUIRES_PERMISSION ?? 'true').toLowerCase() === 'true',
    registrationEnabled: String(rawEnv.REGISTRATION_ENABLED ?? 'true').toLowerCase() === 'true',
    registrationCodeTtlMinutes: Math.max(2, Math.min(60, Number(rawEnv.REGISTRATION_CODE_TTL_MINUTES || 15))),
    registrationCodeResendCooldownSec: Math.max(10, Math.min(600, Number(rawEnv.REGISTRATION_CODE_RESEND_COOLDOWN_SEC || 60))),
    registrationCodeMaxAttempts: Math.max(3, Math.min(12, Number(rawEnv.REGISTRATION_CODE_MAX_ATTEMPTS || 6))),
    registrationMinPasswordLength: Math.max(8, Math.min(72, Number(rawEnv.REGISTRATION_MIN_PASSWORD_LENGTH || 8))),
    passwordResetTtlMinutes: Math.max(5, Math.min(180, Number(rawEnv.PASSWORD_RESET_TTL_MINUTES || 60))),
    appDisplayName: String(rawEnv.APP_DISPLAY_NAME || 'archimap').trim() || 'archimap',
    logLevel: String(rawEnv.LOG_LEVEL || 'info').trim().toLowerCase() || 'info',
    metricsEnabled: String(rawEnv.METRICS_ENABLED ?? 'true').toLowerCase() === 'true',
    searchIndexBatchSize: Math.max(200, Math.min(20000, Number(rawEnv.SEARCH_INDEX_BATCH_SIZE || 2500))),
    rtreeRebuildBatchSize: Math.max(500, Math.min(20000, Number(rawEnv.RTREE_REBUILD_BATCH_SIZE || 4000))),
    rtreeRebuildPauseMs: Math.max(0, Math.min(200, Number(rawEnv.RTREE_REBUILD_PAUSE_MS || 8))),
    paths: {
      dataDir,
      dbPath: String(
        rawEnv.DATABASE_PATH
        || rawEnv.ARCHIMAP_DB_PATH
        || runtimeEnv.sqliteUrl
        || path.join(dataDir, 'archimap.db')
      ).trim() || path.join(dataDir, 'archimap.db'),
      osmDbPath: String(rawEnv.OSM_DB_PATH || path.join(dataDir, 'osm.db')).trim() || path.join(dataDir, 'osm.db'),
      localEditsDbPath: rawEnv.LOCAL_EDITS_DB_PATH || path.join(dataDir, 'local-edits.db'),
      userEditsDbPath: rawEnv.USER_EDITS_DB_PATH || path.join(dataDir, 'user-edits.db'),
      userAuthDbPath: String(rawEnv.USER_AUTH_DB_PATH || path.join(dataDir, 'users.db')).trim() || path.join(dataDir, 'users.db'),
      frontendIndexPath,
      cspScriptHashes: collectInlineScriptHashesFromFile(frontendIndexPath),
      syncRegionScriptPath: path.join(rootDir, 'scripts', 'sync-osm-region.js'),
      searchRebuildScriptPath: path.join(rootDir, 'workers', 'rebuild-search-index.worker.js'),
      filterTagKeysRebuildScriptPath: path.join(rootDir, 'workers', 'rebuild-filter-tag-keys-cache.worker.js')
    }
  };
}

module.exports = {
  createServerRuntimeConfig
};
