function createFilterTagKeysBoot(options: LooseRecord = {}) {
  const {
    db,
    dbProvider,
    logger,
    spawn,
    processExecPath,
    rootDir,
    filterTagKeysRebuildScriptPath,
    env = process.env,
    sqlite = {},
    getEffectiveFilterTagAllowlist,
    normalizeFilterTagKey,
    isShuttingDown = () => false
  } = options;

  let filterTagKeysCache = { keys: null, loadedAt: 0 };
  let filterTagKeysRebuildInProgress = false;
  let queuedFilterTagKeysRebuildReason = null;
  let currentFilterTagKeysRebuildChild = null;

  const selectFilterTagKeysFromCache = db.prepare(`
    SELECT tag_key
    FROM filter_tag_keys_cache
    ORDER BY ${dbProvider === 'postgres' ? 'lower(tag_key), tag_key' : 'tag_key COLLATE NOCASE'}
  `);

  function scheduleFilterTagKeysCacheRebuild(reason = 'manual') {
    if (filterTagKeysRebuildInProgress) {
      queuedFilterTagKeysRebuildReason = reason;
      return;
    }

    filterTagKeysRebuildInProgress = true;
    logger.info('filter_tags_rebuild_started', { reason });
    const child = spawn(processExecPath, ['--import', 'tsx', filterTagKeysRebuildScriptPath], {
      cwd: rootDir,
      env: {
        ...env,
        DB_PROVIDER: dbProvider,
        FILTER_TAG_KEYS_REBUILD_REASON: reason,
        ...(dbProvider === 'sqlite'
          ? {
            ARCHIMAP_DB_PATH: sqlite.dbPath,
            OSM_DB_PATH: sqlite.osmDbPath
          }
          : {})
      },
      stdio: 'inherit'
    });
    currentFilterTagKeysRebuildChild = child;

    child.on('error', (error) => {
      currentFilterTagKeysRebuildChild = null;
      filterTagKeysRebuildInProgress = false;
      logger.error('filter_tags_rebuild_start_failed', { reason, error: String(error.message || error) });
      if (queuedFilterTagKeysRebuildReason) {
        const nextReason = queuedFilterTagKeysRebuildReason;
        queuedFilterTagKeysRebuildReason = null;
        scheduleFilterTagKeysCacheRebuild(nextReason);
      }
    });

    child.on('close', (code, signal) => {
      currentFilterTagKeysRebuildChild = null;
      filterTagKeysRebuildInProgress = false;
      if (isShuttingDown() && (signal === 'SIGTERM' || signal === 'SIGINT')) {
        logger.info('filter_tags_rebuild_stopped', { reason: 'shutdown' });
        return;
      }
      if (code === 0) {
        filterTagKeysCache = { keys: null, loadedAt: 0 };
        logger.info('filter_tags_rebuild_finished', { reason });
      } else {
        logger.error('filter_tags_rebuild_failed', { reason, code });
      }
      if (queuedFilterTagKeysRebuildReason) {
        const nextReason = queuedFilterTagKeysRebuildReason;
        queuedFilterTagKeysRebuildReason = null;
        scheduleFilterTagKeysCacheRebuild(nextReason);
      }
    });
  }

  async function getAllFilterTagKeysCached() {
    const now = Date.now();
    const ttlMs = 5 * 60 * 1000;
    if (Array.isArray(filterTagKeysCache.keys) && (now - filterTagKeysCache.loadedAt) < ttlMs) {
      return filterTagKeysCache.keys;
    }
    const cachedKeys = (await selectFilterTagKeysFromCache.all())
      .map((row) => String(row?.tag_key || '').trim())
      .filter(Boolean);

    if (cachedKeys.length > 0) {
      filterTagKeysCache = { keys: cachedKeys, loadedAt: now };
      return cachedKeys;
    }

    if (!filterTagKeysRebuildInProgress) {
      scheduleFilterTagKeysCacheRebuild('cold-start');
    }
    filterTagKeysCache = { keys: [], loadedAt: now };
    return [];
  }

  async function getFilterTagKeysCached() {
    const allKeys = await getAllFilterTagKeysCached();
    const allowedSet = getEffectiveFilterTagAllowlist().allowlistSet || new Set();
    return allKeys.filter((key) => allowedSet.has(key));
  }

  function isFilterTagAllowed(key) {
    const normalized = normalizeFilterTagKey(key);
    if (!normalized) return false;
    return Boolean(getEffectiveFilterTagAllowlist().allowlistSet?.has(normalized));
  }

  function resetFilterTagKeysCache() {
    filterTagKeysCache = { keys: null, loadedAt: 0 };
  }

  function stop() {
    if (currentFilterTagKeysRebuildChild && !currentFilterTagKeysRebuildChild.killed) {
      try {
        currentFilterTagKeysRebuildChild.kill('SIGTERM');
      } catch {
        // ignore shutdown cleanup errors
      }
    }
  }

  return {
    scheduleFilterTagKeysCacheRebuild,
    getAllFilterTagKeysCached,
    getFilterTagKeysCached,
    isFilterTagAllowed,
    resetFilterTagKeysCache,
    stop,
    isFilterTagKeysRebuildInProgress: () => filterTagKeysRebuildInProgress
  };
}

module.exports = {
  createFilterTagKeysBoot
};
