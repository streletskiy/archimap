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
    getMergedInfoRow,
    getLatestUserEditRow,
    normalizeUserEditStatus,
    sanitizeArchiPayload,
    supersedePendingUserEdits
  } = deps;
  const isPostgres = db.provider === 'postgres';
  const bboxCache = createLruCache({ max: 100, ttlMs: 10 * 1000 });
  const filterMatchesCache = createLruCache({ max: 220, ttlMs: 4000 });

  const selectFilterDataBboxRtree = !isPostgres ? db.prepare(`
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

  const selectFilterDataBboxPlain = !isPostgres ? db.prepare(`
    ${FILTER_DATA_SELECT_FIELDS_SQL}
    WHERE bc.max_lon >= ?
      AND bc.min_lon <= ?
      AND bc.max_lat >= ?
      AND bc.min_lat <= ?
    LIMIT ?
  `) : null;

  const selectFilterDataBboxPostgis = isPostgres ? db.prepare(`
    ${FILTER_DATA_SELECT_FIELDS_SQL}
    WHERE bc.geom && ST_MakeEnvelope(?, ?, ?, ?, 4326)
      AND ST_Intersects(bc.geom, ST_MakeEnvelope(?, ?, ?, ?, 4326))
    LIMIT ?
  `) : null;

  const selectFilterMatchCandidatesRtree = !isPostgres ? db.prepare(`
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

  const selectFilterMatchCandidatesPlain = !isPostgres ? db.prepare(`
    ${FILTER_DATA_SELECT_FIELDS_SQL}
    WHERE bc.max_lon >= ?
      AND bc.min_lon <= ?
      AND bc.max_lat >= ?
      AND bc.min_lat <= ?
    LIMIT ?
  `) : null;

  const selectFilterMatchCandidatesPostgis = isPostgres ? db.prepare(`
    ${FILTER_DATA_SELECT_FIELDS_SQL}
    WHERE bc.geom && ST_MakeEnvelope(?, ?, ?, ?, 4326)
      AND ST_Intersects(bc.geom, ST_MakeEnvelope(?, ?, ?, ?, 4326))
    LIMIT ?
  `) : null;

  const selectBuildingById = db.prepare(`
    SELECT osm_type, osm_id, tags_json, geometry_json
    FROM osm.building_contours
    WHERE osm_type = ? AND osm_id = ?
  `);

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
      const clauses = chunk.map(() => '(bc.osm_type = ? AND bc.osm_id = ?)').join(' OR ');
      const params = [];
      for (const item of chunk) {
        params.push(item.osmType, item.osmId);
      }
      const rows = await db.prepare(`
        ${FILTER_DATA_SELECT_FIELDS_SQL}
        WHERE ${clauses}
      `).all(...params);

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
    const minLon = Number(req.query.minLon);
    const minLat = Number(req.query.minLat);
    const maxLon = Number(req.query.maxLon);
    const maxLat = Number(req.query.maxLat);
    const limit = Math.max(1, Math.min(50000, Number(req.query.limit) || 12000));
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
      return res.status(400).json({ error: 'Некорректные координаты bbox' });
    }
    if (minLon > maxLon || minLat > maxLat) {
      return res.status(400).json({ error: 'Некорректные границы bbox' });
    }

    const actorKey = getSessionEditActorKey(req);
    const queryMode = isPostgres ? 'postgis' : (rtreeState.ready ? 'rtree' : 'plain');
    const cacheKey = `${actorKey || 'anon'}:${minLon.toFixed(5)}:${minLat.toFixed(5)}:${maxLon.toFixed(5)}:${maxLat.toFixed(5)}:${limit}:${queryMode}`;
    const cached = bboxCache.get(cacheKey);
    if (cached) {
      return sendCachedJson(req, res, cached, {
        cacheControl: 'public, max-age=10'
      });
    }

    const rows = isPostgres
      ? await selectFilterDataBboxPostgis.all(
        minLon, minLat, maxLon, maxLat,
        minLon, minLat, maxLon, maxLat,
        limit
      )
      : (rtreeState.ready
        ? await selectFilterDataBboxRtree.all(minLon, maxLon, minLat, maxLat, limit)
        : await selectFilterDataBboxPlain.all(minLon, maxLon, minLat, maxLat, limit));

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
    const bbox = body?.bbox && typeof body.bbox === 'object' ? body.bbox : body;
    const minLon = Number(bbox?.west);
    const minLat = Number(bbox?.south);
    const maxLon = Number(bbox?.east);
    const maxLat = Number(bbox?.north);
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
      return res.status(400).json({ error: 'Некорректные координаты bbox' });
    }
    if (minLon > maxLon || minLat > maxLat) {
      return res.status(400).json({ error: 'Некорректные границы bbox' });
    }

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
    const queryMode = isPostgres ? 'postgis' : (rtreeState.ready ? 'rtree' : 'plain');
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

    const isHeavy = normalizedRules.some((rule) => rule.op === 'contains');
    const candidateLimit = Math.max(
      maxResults,
      Math.min(FILTER_MATCH_CANDIDATE_CAP, Math.max(maxResults * (isHeavy ? 8 : 6), 5000))
    );

    const candidateRows = isPostgres
      ? await selectFilterMatchCandidatesPostgis.all(
        minLon, minLat, maxLon, maxLat,
        minLon, minLat, maxLon, maxLat,
        candidateLimit
      )
      : (rtreeState.ready
        ? await selectFilterMatchCandidatesRtree.all(minLon, maxLon, minLat, maxLat, candidateLimit)
        : await selectFilterMatchCandidatesPlain.all(minLon, maxLon, minLat, maxLat, candidateLimit));

    const candidateItems = await applyPersonalEditsToFilterItems(candidateRows.map(mapFilterDataRow), actorKeyRaw);
    const matchedKeys = [];
    const matchedFeatureIds = [];
    let truncated = false;

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
    const row = personal || merged;
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
      updated_by: row.created_by ?? row.updated_by ?? null,
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
    const payload = validated.value;

    const tx = db.transaction(async () => {
      const latest = await getLatestUserEditRow(osmType, osmId, actorKey, ['pending']);
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
            name, style, levels, year_built, architect, address, archimap_description,
            status, created_at, updated_at
          )
          VALUES (
            @osm_type, @osm_id, @created_by,
            @name, @style, @levels, @year_built, @architect, @address, @archimap_description,
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
          name, style, levels, year_built, architect, address, archimap_description,
          status, created_at, updated_at
        )
        VALUES (
          @osm_type, @osm_id, @created_by,
          @name, @style, @levels, @year_built, @architect, @address, @archimap_description,
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
  registerBuildingsRoutes
};
