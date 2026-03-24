function createDesignRefSuggestionsBoot(options: LooseRecord = {}) {
  const {
    db,
    dbProvider,
    logger = console
  } = options;

  if (!db) {
    throw new Error('createDesignRefSuggestionsBoot: db is required');
  }

  let cachedValues = [];
  let loadedAt = 0;
  let refreshPromise = null;

  const selectDesignRefSuggestions = db.prepare(dbProvider === 'postgres'
    ? `
      WITH values_union AS (
        SELECT NULLIF(btrim(design_ref), '') AS value
        FROM local.architectural_info
        UNION
        SELECT NULLIF(btrim(design_ref), '') AS value
        FROM user_edits.building_user_edits
        UNION
        SELECT NULLIF(btrim(
          CASE
            WHEN tags_json ~ '^\\s*\\{' THEN tags_json::jsonb ->> 'design:ref'
            ELSE NULL
          END
        ), '') AS value
        FROM osm.building_contours
      )
      SELECT value
      FROM values_union
      WHERE value IS NOT NULL
      ORDER BY lower(value), value
    `
    : `
      WITH values_union AS (
        SELECT NULLIF(trim(design_ref), '') AS value
        FROM local.architectural_info
        UNION
        SELECT NULLIF(trim(design_ref), '') AS value
        FROM user_edits.building_user_edits
        UNION
        SELECT NULLIF(trim(CASE WHEN json_valid(tags_json) THEN json_extract(tags_json, '$."design:ref"') END), '') AS value
        FROM osm.building_contours
      )
      SELECT value
      FROM values_union
      WHERE value IS NOT NULL
      ORDER BY value COLLATE NOCASE, value
    `);

  async function refreshDesignRefSuggestionsCache(reason = 'manual') {
    if (refreshPromise) {
      return refreshPromise;
    }
    refreshPromise = Promise.resolve()
      .then(async () => {
        const rows = await selectDesignRefSuggestions.all();
        cachedValues = rows
          .map((row) => String(row?.value || '').trim())
          .filter(Boolean);
        loadedAt = Date.now();
        logger.info?.('design_ref_suggestions_refreshed', {
          reason,
          count: cachedValues.length
        });
        return cachedValues;
      })
      .catch((error) => {
        logger.error?.('design_ref_suggestions_refresh_failed', {
          reason,
          error: String(error?.message || error)
        });
        return cachedValues;
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  }

  async function getDesignRefSuggestionsCached() {
    if (cachedValues.length === 0 && loadedAt === 0) {
      return refreshDesignRefSuggestionsCache('cold-start');
    }
    return cachedValues;
  }

  function resetDesignRefSuggestionsCache() {
    cachedValues = [];
    loadedAt = 0;
  }

  return {
    getDesignRefSuggestionsCached,
    refreshDesignRefSuggestionsCache,
    resetDesignRefSuggestionsCache
  };
}

module.exports = {
  createDesignRefSuggestionsBoot
};
