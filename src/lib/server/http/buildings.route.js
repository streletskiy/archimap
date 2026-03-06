const { sendCachedJson } = require('../infra/http-cache.infra');
const { createLruCache } = require('../infra/lru-cache.infra');

const FILTER_RULE_OPS = new Set(['contains', 'equals', 'not_equals', 'starts_with', 'exists', 'not_exists']);
const FILTER_MATCH_MAX_RULES = 30;
const FILTER_MATCH_MAX_KEY_LEN = 80;
const FILTER_MATCH_MAX_VALUE_LEN = 240;
const FILTER_MATCH_MAX_RESULTS = 20000;
const FILTER_MATCH_DEFAULT_RESULTS = 12000;
const FILTER_MATCH_CANDIDATE_CAP = 50000;
const ARCHI_RULE_KEYS = new Set(['name', 'style', 'levels', 'year_built', 'architect', 'address', 'description', 'archimap_description']);
const ARCHI_RULE_COLUMN_ORDER = ['name', 'style', 'levels', 'year_built', 'architect', 'address', 'description', 'archimap_description'];

function getPostgresArchiFallbackSql(key, rowAlias = 'src') {
  const alias = String(rowAlias || 'src').trim() || 'src';
  if (key === 'name') return `${alias}.name`;
  if (key === 'style') return `${alias}.style`;
  if (key === 'levels') return `${alias}.levels::text`;
  if (key === 'year_built') return `${alias}.year_built::text`;
  if (key === 'architect') return `${alias}.architect`;
  if (key === 'address') return `${alias}.address`;
  if (key === 'description') return `${alias}.description`;
  if (key === 'archimap_description') return `COALESCE(${alias}.archimap_description, ${alias}.description)`;
  return 'NULL::text';
}

function buildPostgresRuleValueSql(ruleKey, { rowAlias = 'src', tagsAlias = `${rowAlias}.tags_jsonb` } = {}) {
  const key = String(ruleKey || '');
  let fallbackKey = null;
  if (key.startsWith('archi.')) {
    fallbackKey = key.slice(6);
  } else if (ARCHI_RULE_KEYS.has(key)) {
    fallbackKey = key;
  }
  const fallbackSql = fallbackKey ? getPostgresArchiFallbackSql(fallbackKey, rowAlias) : 'NULL::text';
  return {
    sql: `CASE WHEN jsonb_exists(${tagsAlias}, ?) THEN jsonb_extract_path_text(${tagsAlias}, ?) ELSE ${fallbackSql} END`,
    params: [key, key]
  };
}

function usesArchiFallbackRuleKey(ruleKey) {
  const key = String(ruleKey || '');
  if (!key) return false;
  return key.startsWith('archi.') || ARCHI_RULE_KEYS.has(key);
}

function splitPostgresPushdownRules(rules) {
  const tagOnlyRules = [];
  const fallbackRules = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (usesArchiFallbackRuleKey(rule?.key)) {
      fallbackRules.push(rule);
    } else {
      tagOnlyRules.push(rule);
    }
  }
  return { tagOnlyRules, fallbackRules };
}

function collectRequiredArchiColumns(rules) {
  const required = new Set();
  for (const rule of Array.isArray(rules) ? rules : []) {
    const key = String(rule?.key || '');
    let fallbackKey = null;
    if (key.startsWith('archi.')) {
      fallbackKey = key.slice(6);
    } else if (ARCHI_RULE_KEYS.has(key)) {
      fallbackKey = key;
    }

    if (!ARCHI_RULE_KEYS.has(fallbackKey)) continue;
    required.add(fallbackKey);
    if (fallbackKey === 'archimap_description') {
      required.add('description');
    }
  }
  return ARCHI_RULE_COLUMN_ORDER.filter((column) => required.has(column));
}

function compilePostgresFilterRulePredicate(rule, options = {}) {
  if (!rule?.key) return { sql: 'TRUE', params: [] };
  const op = String(rule.op || '').trim();
  if (!FILTER_RULE_OPS.has(op)) {
    throw new Error(`Unsupported filter rule operator: ${op}`);
  }

  const valueExpr = buildPostgresRuleValueSql(rule.key, options);
  const params = [...valueExpr.params];

  if (op === 'exists') {
    return {
      sql: `COALESCE(length(btrim(${valueExpr.sql})), 0) > 0`,
      params
    };
  }
  if (op === 'not_exists') {
    return {
      sql: `COALESCE(length(btrim(${valueExpr.sql})), 0) = 0`,
      params
    };
  }

  const right = String(rule.valueNormalized || '').toLowerCase();
  params.push(right);

  if (op === 'equals') {
    return {
      sql: `lower(${valueExpr.sql}) = ?`,
      params
    };
  }
  if (op === 'not_equals') {
    return {
      sql: `lower(${valueExpr.sql}) <> ?`,
      params
    };
  }
  if (op === 'starts_with') {
    return {
      sql: `lower(${valueExpr.sql}) LIKE (? || '%')`,
      params
    };
  }
  return {
    sql: `strpos(lower(${valueExpr.sql}), ?) > 0`,
    params
  };
}

function compilePostgresFilterRulesPredicate(rules, options = {}) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { sql: 'TRUE', params: [] };
  }

  const parts = [];
  const params = [];
  for (const rule of rules) {
    const compiled = compilePostgresFilterRulePredicate(rule, options);
    parts.push(`(${compiled.sql})`);
    params.push(...compiled.params);
  }
  return {
    sql: parts.join(' AND '),
    params
  };
}

function compilePostgresFilterRuleGuardPredicate(rule, options = {}) {
  if (!rule?.key) return { sql: 'TRUE', params: [] };
  const op = String(rule.op || '').trim();
  if (!FILTER_RULE_OPS.has(op)) {
    throw new Error(`Unsupported filter rule operator: ${op}`);
  }

  const tagsAlias = String(options.tagsAlias || `${String(options.rowAlias || 'base')}.tags_jsonb`).trim();
  const key = String(rule.key || '');
  const right = String(rule.valueNormalized || '').toLowerCase();
  const tagExistsSql = `jsonb_exists(${tagsAlias}, ?)`;
  const tagValueSql = `jsonb_extract_path_text(${tagsAlias}, ?)`;

  if (!usesArchiFallbackRuleKey(key)) {
    if (op === 'exists') {
      return {
        sql: `COALESCE(length(btrim(${tagValueSql})), 0) > 0`,
        params: [key]
      };
    }
    if (op === 'not_exists') {
      return {
        sql: `COALESCE(length(btrim(${tagValueSql})), 0) = 0`,
        params: [key]
      };
    }
    if (op === 'equals') {
      return {
        sql: `lower(${tagValueSql}) = ?`,
        params: [key, right]
      };
    }
    if (op === 'not_equals') {
      return {
        sql: `lower(${tagValueSql}) <> ?`,
        params: [key, right]
      };
    }
    if (op === 'starts_with') {
      return {
        sql: `lower(${tagValueSql}) LIKE (? || '%')`,
        params: [key, right]
      };
    }
    return {
      sql: `strpos(lower(${tagValueSql}), ?) > 0`,
      params: [key, right]
    };
  }

  if (op === 'exists') {
    return {
      sql: `NOT (${tagExistsSql} AND COALESCE(length(btrim(${tagValueSql})), 0) = 0)`,
      params: [key, key]
    };
  }
  if (op === 'not_exists') {
    return {
      sql: `NOT (${tagExistsSql} AND COALESCE(length(btrim(${tagValueSql})), 0) > 0)`,
      params: [key, key]
    };
  }
  if (op === 'equals') {
    return {
      sql: `NOT (${tagExistsSql} AND (${tagValueSql} IS NULL OR lower(${tagValueSql}) <> ?))`,
      params: [key, key, key, right]
    };
  }
  if (op === 'not_equals') {
    return {
      sql: `NOT (${tagExistsSql} AND (${tagValueSql} IS NULL OR lower(${tagValueSql}) = ?))`,
      params: [key, key, key, right]
    };
  }
  if (op === 'starts_with') {
    return {
      sql: `NOT (${tagExistsSql} AND (${tagValueSql} IS NULL OR lower(${tagValueSql}) NOT LIKE (? || '%')))`,
      params: [key, key, key, right]
    };
  }
  return {
    sql: `NOT (${tagExistsSql} AND (${tagValueSql} IS NULL OR strpos(lower(${tagValueSql}), ?) = 0))`,
    params: [key, key, key, right]
  };
}

function compilePostgresFilterRulesGuardPredicate(rules, options = {}) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { sql: 'TRUE', params: [] };
  }

  const parts = [];
  const params = [];
  for (const rule of rules) {
    const compiled = compilePostgresFilterRuleGuardPredicate(rule, options);
    parts.push(`(${compiled.sql})`);
    params.push(...compiled.params);
  }
  return {
    sql: parts.join(' AND '),
    params
  };
}

function parseOsmKey(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(way|relation)\/(\d+)$/);
  if (!match) return null;
  const osmId = Number(match[2]);
  if (!Number.isInteger(osmId)) return null;
  return { osmType: match[1], osmId };
}

function encodeOsmFeatureId(osmType, osmId) {
  const typeBit = osmType === 'relation' ? 1 : 0;
  return (Number(osmId) * 2) + typeBit;
}

function normalizeFilterRule(rule) {
  const key = String(rule?.key || '').trim();
  const op = String(rule?.op || 'contains').trim();
  const value = String(rule?.value || '').trim();
  if (!key) return { error: 'Rule key is required' };
  if (key.length > FILTER_MATCH_MAX_KEY_LEN) return { error: 'Rule key is too long' };
  if (!FILTER_RULE_OPS.has(op)) return { error: `Invalid rule operator: ${op}` };
  if (value.length > FILTER_MATCH_MAX_VALUE_LEN) return { error: 'Rule value is too long' };
  return {
    value: {
      key,
      op,
      value,
      valueNormalized: value.toLowerCase()
    }
  };
}

function normalizeTagValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.join(';');
  return String(value);
}

function getRuleValue(item, key) {
  const sourceTags = item?.sourceTags && typeof item.sourceTags === 'object' ? item.sourceTags : {};
  if (Object.prototype.hasOwnProperty.call(sourceTags, key)) return sourceTags[key];
  const archiInfo = item?.archiInfo && typeof item.archiInfo === 'object' ? item.archiInfo : {};
  if (key.startsWith('archi.')) {
    return archiInfo[key.slice(6)];
  }
  if (ARCHI_RULE_KEYS.has(key)) {
    return archiInfo[key];
  }
  return undefined;
}

function matchesFilterRule(item, rule) {
  if (!rule?.key) return true;
  const actualRaw = getRuleValue(item, rule.key);
  const actual = normalizeTagValue(actualRaw);
  const hasValue = actual != null && String(actual).trim().length > 0;
  if (rule.op === 'exists') return hasValue;
  if (rule.op === 'not_exists') return !hasValue;
  if (actual == null) return false;

  const left = String(actual).toLowerCase();
  if (rule.op === 'equals') return left === rule.valueNormalized;
  if (rule.op === 'not_equals') return left !== rule.valueNormalized;
  if (rule.op === 'starts_with') return left.startsWith(rule.valueNormalized);
  return left.includes(rule.valueNormalized);
}

function stableRulesHash(rules) {
  const raw = JSON.stringify(Array.isArray(rules) ? rules : []);
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

function buildBboxHash(minLon, minLat, maxLon, maxLat) {
  return `${minLon.toFixed(5)}:${minLat.toFixed(5)}:${maxLon.toFixed(5)}:${maxLat.toFixed(5)}`;
}

function parseBboxInput(source, fields) {
  const minLon = Number(source?.[fields.minLon]);
  const minLat = Number(source?.[fields.minLat]);
  const maxLon = Number(source?.[fields.maxLon]);
  const maxLat = Number(source?.[fields.maxLat]);
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
    return { bbox: null, error: 'Некорректные координаты bbox' };
  }
  if (minLon > maxLon || minLat > maxLat) {
    return { bbox: null, error: 'Некорректные границы bbox' };
  }
  return {
    bbox: {
      minLon,
      minLat,
      maxLon,
      maxLat
    },
    error: ''
  };
}

function resolveBboxQueryMode(isPostgres, rtreeState) {
  if (isPostgres) return 'postgis';
  return rtreeState.ready ? 'rtree' : 'plain';
}

function getFilterMatchCandidateLimit(rules, maxResults) {
  const isHeavy = Array.isArray(rules) && rules.some((rule) => rule.op === 'contains');
  return Math.max(
    maxResults,
    Math.min(FILTER_MATCH_CANDIDATE_CAP, Math.max(maxResults * (isHeavy ? 8 : 6), 5000))
  );
}

function mapFilterDataRow(row) {
  const osmKey = `${row.osm_type}/${row.osm_id}`;
  let sourceTags = {};
  try {
    sourceTags = row.tags_json ? JSON.parse(row.tags_json) : {};
  } catch {
    sourceTags = {};
  }
  const hasExtraInfo = row.info_osm_id != null;
  return {
    osmKey,
    sourceTags,
    archiInfo: hasExtraInfo
      ? {
        osm_type: row.osm_type,
        osm_id: row.osm_id,
        name: row.name,
        style: row.style,
        levels: row.levels,
        year_built: row.year_built,
        architect: row.architect,
        address: row.address,
        description: row.description,
        archimap_description: row.archimap_description || row.description || null,
        updated_by: row.updated_by,
        updated_at: row.updated_at
      }
      : null,
    hasExtraInfo
  };
}

const FILTER_DATA_SELECT_FIELDS_SQL = `
  SELECT
    bc.osm_type,
    bc.osm_id,
    bc.tags_json,
    ai.osm_id AS info_osm_id,
    ai.name,
    ai.style,
    ai.levels,
    ai.year_built,
    ai.architect,
    ai.address,
    ai.description,
    ai.archimap_description,
    ai.updated_by,
    ai.updated_at
  FROM osm.building_contours bc
  LEFT JOIN local.architectural_info ai
    ON ai.osm_type = bc.osm_type AND ai.osm_id = bc.osm_id
`;

const FILTER_DATA_POSTGIS_BBOX_SQL = `
  WITH env AS (
    SELECT ST_MakeEnvelope(?, ?, ?, ?, 4326) AS geom
  )
  ${FILTER_DATA_SELECT_FIELDS_SQL}
  JOIN env ON bc.geom && env.geom
  WHERE ST_Intersects(bc.geom, env.geom)
  LIMIT ?
`;

function registerBuildingsRoutes(deps) {
  const {
    app,
    db,
    rtreeState,
    buildingsReadRateLimiter,
    buildingsWriteRateLimiter,
    filterDataRateLimiter,
    filterDataBboxRateLimiter,
    filterMatchesRateLimiter,
    requireCsrfSession,
    requireAuth,
    requireBuildingEditPermission,
    getSessionEditActorKey,
    applyPersonalEditsToFilterItems,
    rowToFeature,
    attachInfoToFeatures,
    applyUserEditRowToInfo,
    getMergedInfoRow,
    getLatestUserEditRow,
    normalizeUserEditStatus,
    sanitizeArchiPayload,
    sanitizeEditedFields,
    supersedePendingUserEdits
  } = deps;
  const isPostgres = db.provider === 'postgres';
  const bboxCache = createLruCache({ max: 100, ttlMs: 10 * 1000 });
  const filterMatchesCache = createLruCache({ max: 220, ttlMs: 4000 });

  const selectFilterRowsBboxRtree = !isPostgres ? db.prepare(`
    SELECT
      bc.osm_type,
      bc.osm_id,
      bc.tags_json,
      ai.osm_id AS info_osm_id,
      ai.name,
      ai.style,
      ai.levels,
      ai.year_built,
      ai.architect,
      ai.address,
      ai.description,
      ai.archimap_description,
      ai.updated_by,
      ai.updated_at
    FROM osm.building_contours_rtree br
    JOIN osm.building_contours bc
      ON bc.rowid = br.contour_rowid
    LEFT JOIN local.architectural_info ai
      ON ai.osm_type = bc.osm_type AND ai.osm_id = bc.osm_id
    WHERE br.max_lon >= ?
      AND br.min_lon <= ?
      AND br.max_lat >= ?
      AND br.min_lat <= ?
    LIMIT ?
  `) : null;

  const selectFilterRowsBboxPlain = !isPostgres ? db.prepare(`
    ${FILTER_DATA_SELECT_FIELDS_SQL}
    WHERE bc.max_lon >= ?
      AND bc.min_lon <= ?
      AND bc.max_lat >= ?
      AND bc.min_lat <= ?
    LIMIT ?
  `) : null;

  const selectFilterRowsBboxPostgis = isPostgres ? db.prepare(FILTER_DATA_POSTGIS_BBOX_SQL) : null;

  const selectBuildingById = db.prepare(`
    SELECT osm_type, osm_id, tags_json, geometry_json
    FROM osm.building_contours
    WHERE osm_type = ? AND osm_id = ?
  `);

  function getBboxQueryMode() {
    return resolveBboxQueryMode(isPostgres, rtreeState);
  }

  async function selectFilterRowsByBbox(minLon, minLat, maxLon, maxLat, limit) {
    const queryMode = getBboxQueryMode();
    if (queryMode === 'postgis') {
      return selectFilterRowsBboxPostgis.all(minLon, minLat, maxLon, maxLat, limit);
    }
    if (queryMode === 'rtree') {
      return selectFilterRowsBboxRtree.all(minLon, maxLon, minLat, maxLat, limit);
    }
    return selectFilterRowsBboxPlain.all(minLon, maxLon, minLat, maxLat, limit);
  }

  app.post('/api/buildings/filter-data', filterDataRateLimiter, async (req, res) => {
    const rawKeys = req.body?.keys;
    if (!Array.isArray(rawKeys)) {
      return res.status(400).json({ error: 'Ожидается массив keys' });
    }

    const unique = [];
    const seen = new Set();
    for (const raw of rawKeys) {
      const parsed = parseOsmKey(raw);
      if (!parsed) continue;
      const key = `${parsed.osmType}/${parsed.osmId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(parsed);
      if (unique.length >= 5000) break;
    }

    if (unique.length === 0) {
      return res.json({ items: [] });
    }

    const outByKey = new Map();
    const CHUNK_SIZE = 300;
    for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
      const chunk = unique.slice(i, i + CHUNK_SIZE);
      const rows = isPostgres
        ? await (() => {
          const valuesSql = chunk.map(() => '(?::text, ?::bigint)').join(', ');
          const params = [];
          for (const item of chunk) {
            params.push(item.osmType, item.osmId);
          }
          return db.prepare(`
            WITH requested(osm_type, osm_id) AS (
              VALUES ${valuesSql}
            )
            ${FILTER_DATA_SELECT_FIELDS_SQL}
            JOIN requested req
              ON bc.osm_type = req.osm_type AND bc.osm_id = req.osm_id
          `).all(...params);
        })()
        : await (() => {
          const clauses = chunk.map(() => '(bc.osm_type = ? AND bc.osm_id = ?)').join(' OR ');
          const params = [];
          for (const item of chunk) {
            params.push(item.osmType, item.osmId);
          }
          return db.prepare(`
            ${FILTER_DATA_SELECT_FIELDS_SQL}
            WHERE ${clauses}
          `).all(...params);
        })();

      for (const row of rows) {
        const item = mapFilterDataRow(row);
        outByKey.set(item.osmKey, item);
      }
    }

    const actorKey = getSessionEditActorKey(req);
    const items = await applyPersonalEditsToFilterItems([...outByKey.values()], actorKey);
    return res.json({ items });
  });

  app.get('/api/buildings/filter-data-bbox', filterDataBboxRateLimiter, async (req, res) => {
    const { bbox, error } = parseBboxInput(req.query, {
      minLon: 'minLon',
      minLat: 'minLat',
      maxLon: 'maxLon',
      maxLat: 'maxLat'
    });
    const limit = Math.max(1, Math.min(50000, Number(req.query.limit) || 12000));
    if (error) {
      return res.status(400).json({ error });
    }

    const { minLon, minLat, maxLon, maxLat } = bbox;
    const actorKey = getSessionEditActorKey(req);
    const queryMode = getBboxQueryMode();
    const cacheKey = `${actorKey || 'anon'}:${minLon.toFixed(5)}:${minLat.toFixed(5)}:${maxLon.toFixed(5)}:${maxLat.toFixed(5)}:${limit}:${queryMode}`;
    const cached = bboxCache.get(cacheKey);
    if (cached) {
      return sendCachedJson(req, res, cached, {
        cacheControl: 'public, max-age=10'
      });
    }

    const rows = await selectFilterRowsByBbox(minLon, minLat, maxLon, maxLat, limit);
    const items = await applyPersonalEditsToFilterItems(rows.map(mapFilterDataRow), actorKey);
    const payload = { items, truncated: rows.length >= limit };
    bboxCache.set(cacheKey, payload);
    return sendCachedJson(req, res, payload, {
      cacheControl: 'public, max-age=10'
    });
  });

  app.post('/api/buildings/filter-matches', filterMatchesRateLimiter, async (req, res) => {
    const startedAt = Date.now();
    const body = req.body || {};
    const { bbox, error } = parseBboxInput(
      body?.bbox && typeof body.bbox === 'object' ? body.bbox : body,
      { minLon: 'west', minLat: 'south', maxLon: 'east', maxLat: 'north' }
    );
    if (error) {
      return res.status(400).json({ error });
    }
    const { minLon, minLat, maxLon, maxLat } = bbox;

    const rulesRaw = body?.rules;
    if (!Array.isArray(rulesRaw)) {
      return res.status(400).json({ error: 'Ожидается массив rules' });
    }
    if (rulesRaw.length > FILTER_MATCH_MAX_RULES) {
      return res.status(400).json({ error: `Слишком много правил (максимум ${FILTER_MATCH_MAX_RULES})` });
    }

    const normalizedRules = [];
    for (const entry of rulesRaw) {
      const parsed = normalizeFilterRule(entry);
      if (parsed.error) {
        return res.status(400).json({ error: parsed.error });
      }
      normalizedRules.push(parsed.value);
    }

    const zoom = Number(body?.zoom);
    const zoomBucket = Number.isFinite(Number(body?.zoomBucket))
      ? Number(body.zoomBucket)
      : (Number.isFinite(zoom) ? Math.round(zoom * 2) / 2 : 0);
    const maxResultsRaw = Number(body?.maxResults ?? body?.limit);
    const maxResults = Math.max(
      1,
      Math.min(FILTER_MATCH_MAX_RESULTS, Number.isFinite(maxResultsRaw) ? maxResultsRaw : FILTER_MATCH_DEFAULT_RESULTS)
    );
    const rulesHash = String(body?.rulesHash || '').trim() || stableRulesHash(normalizedRules);
    const bboxHash = buildBboxHash(minLon, minLat, maxLon, maxLat);
    const actorKeyRaw = getSessionEditActorKey(req);
    const actorKey = String(actorKeyRaw || '').trim().toLowerCase() || 'anon';
    const queryMode = getBboxQueryMode();
    const cacheKey = `${actorKey}:${rulesHash}:${bboxHash}:${zoomBucket}:${maxResults}:${queryMode}`;
    const cached = filterMatchesCache.get(cacheKey);
    if (cached) {
      return res.json({
        ...cached,
        meta: {
          ...cached.meta,
          cacheHit: true,
          elapsedMs: Date.now() - startedAt
        }
      });
    }

    if (normalizedRules.length === 0) {
      const payload = {
        matchedKeys: [],
        matchedFeatureIds: [],
        meta: {
          rulesHash,
          bboxHash,
          truncated: false,
          elapsedMs: Date.now() - startedAt,
          cacheHit: false
        }
      };
      filterMatchesCache.set(cacheKey, payload);
      return res.json(payload);
    }

    const matchedKeys = [];
    const matchedFeatureIds = [];
    let truncated = false;

    if (isPostgres && actorKey === 'anon') {
      const splitRules = splitPostgresPushdownRules(normalizedRules);
      const rows = splitRules.fallbackRules.length === 0
        ? await (() => {
          const compiledTagRules = compilePostgresFilterRulesPredicate(splitRules.tagOnlyRules, {
            rowAlias: 'base',
            tagsAlias: 'base.tags_jsonb'
          });
          const selectTagOnlyRowsSql = `
            WITH env AS (
              SELECT ST_MakeEnvelope(?, ?, ?, ?, 4326) AS geom
            ),
            base AS MATERIALIZED (
              SELECT
                bc.osm_type,
                bc.osm_id,
                CASE
                  WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb
                  ELSE '{}'::jsonb
                END AS tags_jsonb
              FROM osm.building_contours bc
              JOIN env
                ON bc.geom && env.geom
              WHERE ST_Intersects(bc.geom, env.geom)
            )
            SELECT base.osm_type, base.osm_id
            FROM base
            WHERE ${compiledTagRules.sql}
            LIMIT ?
          `;
          return db.prepare(selectTagOnlyRowsSql).all(
            minLon, minLat, maxLon, maxLat,
            ...compiledTagRules.params,
            maxResults + 1
          );
        })()
        : null;

      if (rows) {
        const limitedRows = rows.length > maxResults ? rows.slice(0, maxResults) : rows;
        truncated = rows.length > maxResults;
        for (const row of limitedRows) {
          const osmType = String(row.osm_type || '');
          const osmId = Number(row.osm_id);
          if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) continue;
          matchedKeys.push(`${osmType}/${osmId}`);
          matchedFeatureIds.push(encodeOsmFeatureId(osmType, osmId));
        }
      } else {
        const candidateLimit = getFilterMatchCandidateLimit(normalizedRules, maxResults);
        const requiredArchiColumns = collectRequiredArchiColumns(splitRules.fallbackRules);
        const aiJoinSql = requiredArchiColumns.length > 0
          ? `
          LEFT JOIN local.architectural_info ai
            ON ai.osm_type = guarded.osm_type AND ai.osm_id = guarded.osm_id
          `
          : '';
        const aiSelectSql = requiredArchiColumns.length > 0
          ? `ai.osm_id AS info_osm_id,
            ${requiredArchiColumns.map((column) => `ai.${column}`).join(',\n            ')}`
          : 'NULL::bigint AS info_osm_id';
        const compiledGuardRules = compilePostgresFilterRulesGuardPredicate(normalizedRules, {
          rowAlias: 'base',
          tagsAlias: 'base.tags_jsonb'
        });
        const selectGuardedCandidateRowsSql = `
          WITH env AS (
            SELECT ST_MakeEnvelope(?, ?, ?, ?, 4326) AS geom
          ),
          base AS MATERIALIZED (
            SELECT
              bc.osm_type,
              bc.osm_id,
              bc.tags_json,
              CASE
                WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb
                ELSE '{}'::jsonb
              END AS tags_jsonb
            FROM osm.building_contours bc
            JOIN env
              ON bc.geom && env.geom
            WHERE ST_Intersects(bc.geom, env.geom)
          ),
          guarded AS MATERIALIZED (
            SELECT
              base.osm_type,
              base.osm_id,
              base.tags_json
            FROM base
            WHERE ${compiledGuardRules.sql}
            LIMIT ?
          )
          SELECT
            guarded.osm_type,
            guarded.osm_id,
            guarded.tags_json,
            ${aiSelectSql}
          FROM guarded
          ${aiJoinSql}
        `;
        const candidateRows = await db.prepare(selectGuardedCandidateRowsSql).all(
          minLon, minLat, maxLon, maxLat,
          ...compiledGuardRules.params,
          candidateLimit
        );

        const candidateItems = candidateRows.map(mapFilterDataRow);
        for (let i = 0; i < candidateItems.length; i += 1) {
          const item = candidateItems[i];
          const ok = normalizedRules.every((rule) => matchesFilterRule(item, rule));
          if (!ok) continue;
          matchedKeys.push(item.osmKey);
          const parsed = parseOsmKey(item.osmKey);
          if (parsed) {
            matchedFeatureIds.push(encodeOsmFeatureId(parsed.osmType, parsed.osmId));
          }
          if (matchedKeys.length >= maxResults) {
            truncated = true;
            break;
          }
        }
        if (!truncated && candidateRows.length >= candidateLimit) {
          truncated = true;
        }
      }
    } else {
      const candidateLimit = getFilterMatchCandidateLimit(normalizedRules, maxResults);
      const candidateRows = await selectFilterRowsByBbox(minLon, minLat, maxLon, maxLat, candidateLimit);

      const candidateItems = await applyPersonalEditsToFilterItems(candidateRows.map(mapFilterDataRow), actorKeyRaw);
      for (let i = 0; i < candidateItems.length; i += 1) {
        const item = candidateItems[i];
        const ok = normalizedRules.every((rule) => matchesFilterRule(item, rule));
        if (!ok) continue;
        matchedKeys.push(item.osmKey);
        const parsed = parseOsmKey(item.osmKey);
        if (parsed) {
          matchedFeatureIds.push(encodeOsmFeatureId(parsed.osmType, parsed.osmId));
        }
        if (matchedKeys.length >= maxResults) {
          truncated = true;
          break;
        }
      }
      if (!truncated && candidateRows.length >= candidateLimit) {
        truncated = true;
      }
    }

    const payload = {
      matchedKeys,
      matchedFeatureIds,
      meta: {
        rulesHash,
        bboxHash,
        truncated,
        elapsedMs: Date.now() - startedAt,
        cacheHit: false
      }
    };
    filterMatchesCache.set(cacheKey, payload);
    return res.json(payload);
  });

  app.get('/api/building-info/:osmType/:osmId', buildingsReadRateLimiter, async (req, res) => {
    const osmType = req.params.osmType;
    const osmId = Number(req.params.osmId);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
      return res.status(400).json({ error: 'Некорректный идентификатор здания' });
    }

    const merged = await getMergedInfoRow(osmType, osmId);
    const actorKey = getSessionEditActorKey(req);
    const personal = actorKey ? await getLatestUserEditRow(osmType, osmId, actorKey, ['pending', 'rejected']) : null;
    const row = personal ? applyUserEditRowToInfo(merged, personal) : merged;
    if (!row) {
      return res.status(404).json({ error: 'Информация не найдена' });
    }

    return sendCachedJson(req, res, {
      osm_type: osmType,
      osm_id: osmId,
      name: row.name ?? null,
      style: row.style ?? null,
      levels: row.levels ?? null,
      year_built: row.year_built ?? null,
      architect: row.architect ?? null,
      address: row.address ?? null,
      description: row.description ?? null,
      archimap_description: row.archimap_description ?? row.description ?? null,
      updated_by: row.updated_by ?? row.created_by ?? null,
      updated_at: row.updated_at ?? null,
      review_status: personal ? normalizeUserEditStatus(personal.status) : 'accepted',
      admin_comment: personal?.admin_comment ?? null,
      user_edit_id: personal ? Number(personal.id || 0) : null
    }, {
      cacheControl: 'private, no-cache',
      lastModified: row.updated_at || undefined
    });
  });

  app.post('/api/building-info', buildingsWriteRateLimiter, requireCsrfSession, requireAuth, requireBuildingEditPermission, async (req, res) => {
    const body = req.body || {};
    const osmType = body.osmType;
    const osmId = Number(body.osmId);

    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
      return res.status(400).json({ error: 'Некорректный идентификатор здания' });
    }

    const validated = sanitizeArchiPayload(body);
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }
    const actorKey = getSessionEditActorKey(req);
    if (!actorKey) {
      return res.status(400).json({ error: 'Не удалось определить текущего пользователя' });
    }
    const requestedEditedFields = sanitizeEditedFields(body.editedFields);
    if (requestedEditedFields.length === 0) {
      return res.status(409).json({ error: 'В правке нет отличий от текущих данных' });
    }

    const tx = db.transaction(async () => {
      const latest = await getLatestUserEditRow(osmType, osmId, actorKey, ['pending']);
      const previousEditedFields = sanitizeEditedFields(latest?.edited_fields_json);
      const nextEditedFields = [...new Set([...previousEditedFields, ...requestedEditedFields])];
      const payload = {
        ...validated.value,
        edited_fields_json: nextEditedFields.length > 0 ? JSON.stringify(nextEditedFields) : null
      };
      if (latest && Number.isInteger(Number(latest.id)) && Number(latest.id) > 0) {
        await db.prepare(`
          UPDATE user_edits.building_user_edits
          SET
            name = @name,
            style = @style,
            levels = @levels,
            year_built = @year_built,
            architect = @architect,
            address = @address,
            archimap_description = @archimap_description,
            edited_fields_json = @edited_fields_json,
            status = 'pending',
            admin_comment = NULL,
            reviewed_by = NULL,
            reviewed_at = NULL,
            merged_by = NULL,
            merged_at = NULL,
            merged_fields_json = NULL,
            updated_at = datetime('now')
          WHERE id = @id
        `).run({
          id: latest.id,
          ...payload
        });
        await supersedePendingUserEdits(osmType, osmId, actorKey, Number(latest.id));
        return Number(latest.id || 0);
      }

      await supersedePendingUserEdits(osmType, osmId, actorKey, null);
      if (isPostgres) {
        const inserted = await db.prepare(`
          INSERT INTO user_edits.building_user_edits (
            osm_type, osm_id, created_by,
            name, style, levels, year_built, architect, address, archimap_description, edited_fields_json,
            status, created_at, updated_at
          )
          VALUES (
            @osm_type, @osm_id, @created_by,
            @name, @style, @levels, @year_built, @architect, @address, @archimap_description, @edited_fields_json,
            'pending', datetime('now'), datetime('now')
          )
          RETURNING id
        `).get({
          osm_type: osmType,
          osm_id: osmId,
          created_by: actorKey,
          ...payload
        });
        return Number(inserted?.id || 0);
      }

      const inserted = await db.prepare(`
        INSERT INTO user_edits.building_user_edits (
          osm_type, osm_id, created_by,
          name, style, levels, year_built, architect, address, archimap_description, edited_fields_json,
          status, created_at, updated_at
        )
        VALUES (
          @osm_type, @osm_id, @created_by,
          @name, @style, @levels, @year_built, @architect, @address, @archimap_description, @edited_fields_json,
          'pending', datetime('now'), datetime('now')
        )
      `).run({
        osm_type: osmType,
        osm_id: osmId,
        created_by: actorKey,
        ...payload
      });
      return Number(inserted?.lastInsertRowid || 0);
    });

    const editId = await tx();
    return res.json({ ok: true, editId, status: 'pending' });
  });

  app.get('/api/building/:osmType/:osmId', buildingsReadRateLimiter, async (req, res) => {
    const osmType = req.params.osmType;
    const osmId = Number(req.params.osmId);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) {
      return res.status(400).json({ error: 'Некорректный идентификатор здания' });
    }

    const row = await selectBuildingById.get(osmType, osmId);

    if (!row) {
      return res.status(404).json({ error: 'Здание не найдено в локальной базе контуров' });
    }

    const feature = rowToFeature(row);
    await attachInfoToFeatures([feature], { actorKey: getSessionEditActorKey(req) });
    return sendCachedJson(req, res, feature, {
      cacheControl: 'public, max-age=30'
    });
  });
}

module.exports = {
  registerBuildingsRoutes,
  compilePostgresFilterRulePredicate,
  compilePostgresFilterRulesPredicate,
  compilePostgresFilterRuleGuardPredicate,
  compilePostgresFilterRulesGuardPredicate
};
