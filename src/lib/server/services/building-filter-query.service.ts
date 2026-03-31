const {
  collectRequiredArchiColumns,
  compilePostgresFilterRulesGuardPredicate,
  compilePostgresFilterRulesPredicate
} = require('../utils/filter-sql-builder');
const { splitBuildingMaterialSelection } = require('./edits.service');

const FILTER_DATA_SELECT_FIELDS_SQL = `
  SELECT
    bc.osm_type,
    bc.osm_id,
    bc.tags_json,
    bc.min_lon,
    bc.min_lat,
    bc.max_lon,
    bc.max_lat,
    ai.osm_id AS info_osm_id,
    ai.name,
    ai.style,
    ai.design,
    ai.design_ref,
    ai.design_year,
    ai.material,
    ai.material_concrete,
    ai.colour,
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

const FILTER_MATCH_TAGS_ONLY_POSTGIS_BBOX_SQL = `
  WITH env AS (
    SELECT ST_MakeEnvelope(?, ?, ?, ?, 4326) AS geom
  )
  SELECT
    bc.osm_type,
    bc.osm_id,
    bc.tags_json,
    bc.min_lon,
    bc.min_lat,
    bc.max_lon,
    bc.max_lat
  FROM osm.building_contours bc
  JOIN env ON bc.geom && env.geom
  WHERE ST_Intersects(bc.geom, env.geom)
  LIMIT ?
`;

function parseBboxInput(source, fields) {
  const minLon = Number(source?.[fields.minLon]);
  const minLat = Number(source?.[fields.minLat]);
  const maxLon = Number(source?.[fields.maxLon]);
  const maxLat = Number(source?.[fields.maxLat]);
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
    return { bbox: null, error: 'Invalid bbox coordinates' };
  }
  if (minLon > maxLon || minLat > maxLat) {
    return { bbox: null, error: 'Invalid bbox boundaries' };
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
  return rtreeState?.ready ? 'rtree' : 'plain';
}

function mapFilterDataRow(row) {
  const osmKey = `${row.osm_type}/${row.osm_id}`;
  let sourceTags: LooseRecord;
  try {
    sourceTags = row.tags_json ? JSON.parse(row.tags_json) : {};
  } catch {
    sourceTags = {};
  }
  const hasExtraInfo = row.info_osm_id != null;
  const split = hasExtraInfo ? splitBuildingMaterialSelection(row.material) : null;
  const minLon = Number(row.min_lon);
  const minLat = Number(row.min_lat);
  const maxLon = Number(row.max_lon);
  const maxLat = Number(row.max_lat);
  const centerLon = [minLon, maxLon].every(Number.isFinite) ? (minLon + maxLon) / 2 : null;
  const centerLat = [minLat, maxLat].every(Number.isFinite) ? (minLat + maxLat) / 2 : null;
  return {
    osmKey,
    sourceTags,
    archiInfo: hasExtraInfo
      ? {
        osm_type: row.osm_type,
        osm_id: row.osm_id,
        name: row.name,
        style: row.style,
        design: row.design,
        design_ref: row.design_ref,
        design_year: row.design_year,
        material: split?.material ?? row.material,
        material_concrete: split?.material_concrete ?? row.material_concrete,
        colour: row.colour,
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
    hasExtraInfo,
    centerLon,
    centerLat
  };
}

function createBuildingFilterQueryService({ db, rtreeState }) {
  if (!db) {
    throw new Error('createBuildingFilterQueryService: db is required');
  }

  const isPostgres = db.provider === 'postgres';

  const selectFilterRowsBboxRtree = !isPostgres ? db.prepare(`
    SELECT
      bc.osm_type,
      bc.osm_id,
      bc.tags_json,
      bc.min_lon,
      bc.min_lat,
      bc.max_lon,
      bc.max_lat,
      ai.osm_id AS info_osm_id,
      ai.name,
      ai.style,
      ai.design,
      ai.design_ref,
      ai.design_year,
      ai.material,
      ai.material_concrete,
      ai.colour,
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

  const selectFilterMatchRowsBboxRtree = !isPostgres ? db.prepare(`
    SELECT
      bc.osm_type,
      bc.osm_id,
      bc.tags_json,
      bc.min_lon,
      bc.min_lat,
      bc.max_lon,
      bc.max_lat
    FROM osm.building_contours_rtree br
    JOIN osm.building_contours bc
      ON bc.rowid = br.contour_rowid
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

  const selectFilterMatchRowsBboxPlain = !isPostgres ? db.prepare(`
    SELECT
      bc.osm_type,
      bc.osm_id,
      bc.tags_json,
      bc.min_lon,
      bc.min_lat,
      bc.max_lon,
      bc.max_lat
    FROM osm.building_contours bc
    WHERE bc.max_lon >= ?
      AND bc.min_lon <= ?
      AND bc.max_lat >= ?
      AND bc.min_lat <= ?
    LIMIT ?
  `) : null;

  const selectFilterRowsBboxPostgis = isPostgres ? db.prepare(FILTER_DATA_POSTGIS_BBOX_SQL) : null;
  const selectFilterMatchRowsBboxPostgis = isPostgres ? db.prepare(FILTER_MATCH_TAGS_ONLY_POSTGIS_BBOX_SQL) : null;

  function getBboxQueryMode() {
    return resolveBboxQueryMode(isPostgres, rtreeState);
  }

  async function selectFilterRowsByBbox(minLon, minLat, maxLon, maxLat, limit, { tagsOnly = false } = {}) {
    const queryMode = getBboxQueryMode();
    if (queryMode === 'postgis') {
      return tagsOnly
        ? selectFilterMatchRowsBboxPostgis.all(minLon, minLat, maxLon, maxLat, limit)
        : selectFilterRowsBboxPostgis.all(minLon, minLat, maxLon, maxLat, limit);
    }
    if (queryMode === 'rtree') {
      return tagsOnly
        ? selectFilterMatchRowsBboxRtree.all(minLon, maxLon, minLat, maxLat, limit)
        : selectFilterRowsBboxRtree.all(minLon, maxLon, minLat, maxLat, limit);
    }
    return tagsOnly
      ? selectFilterMatchRowsBboxPlain.all(minLon, maxLon, minLat, maxLat, limit)
      : selectFilterRowsBboxPlain.all(minLon, maxLon, minLat, maxLat, limit);
  }

  async function selectFilterDataRowsByKeys(keys = []) {
    const rows = [];
    const CHUNK_SIZE = 300;
    for (let index = 0; index < keys.length; index += CHUNK_SIZE) {
      const chunk = keys.slice(index, index + CHUNK_SIZE);
      const chunkRows = isPostgres
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
      rows.push(...chunkRows);
    }
    return rows;
  }

  async function selectTagOnlyPostgresMatchRowsByBbox({
    minLon,
    minLat,
    maxLon,
    maxLat,
    rules,
    maxResults
  }) {
    if (!isPostgres) return null;
    const compiledTagRules = compilePostgresFilterRulesPredicate(rules, {
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
          bc.tags_json,
          bc.min_lon,
          bc.min_lat,
          bc.max_lon,
          bc.max_lat,
          CASE
            WHEN bc.tags_json ~ '^\\s*\\{' THEN bc.tags_json::jsonb
            ELSE '{}'::jsonb
          END AS tags_jsonb
        FROM osm.building_contours bc
        JOIN env
          ON bc.geom && env.geom
        WHERE ST_Intersects(bc.geom, env.geom)
      )
      SELECT
        base.osm_type,
        base.osm_id,
        base.tags_json,
        base.min_lon,
        base.min_lat,
        base.max_lon,
        base.max_lat
      FROM base
      WHERE ${compiledTagRules.sql}
      LIMIT ?
    `;
    return db.prepare(selectTagOnlyRowsSql).all(
      minLon,
      minLat,
      maxLon,
      maxLat,
      ...compiledTagRules.params,
      maxResults + 1
    );
  }

  async function selectGuardedPostgresCandidateRowsByBbox({
    minLon,
    minLat,
    maxLon,
    maxLat,
    rules,
    archiRules = rules,
    candidateLimit
  }) {
    if (!isPostgres) return [];
    const requiredArchiColumns = collectRequiredArchiColumns(archiRules);
    const aiJoinSql = requiredArchiColumns.length > 0
      ? `
      LEFT JOIN local.architectural_info ai
        ON ai.osm_type = guarded.osm_type AND ai.osm_id = guarded.osm_id
      `
      : '';
    const aiSelectSql = requiredArchiColumns.length > 0
      ? `ai.osm_id AS info_osm_id,
        ${requiredArchiColumns.map((column) => `ai.${column}`).join(',\n        ')}`
      : 'NULL::bigint AS info_osm_id';
    const compiledGuardRules = compilePostgresFilterRulesGuardPredicate(rules, {
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
          bc.min_lon,
          bc.min_lat,
          bc.max_lon,
          bc.max_lat,
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
          base.tags_json,
          base.min_lon,
          base.min_lat,
          base.max_lon,
          base.max_lat
        FROM base
        WHERE ${compiledGuardRules.sql}
        LIMIT ?
      )
      SELECT
        guarded.osm_type,
        guarded.osm_id,
        guarded.tags_json,
        guarded.min_lon,
        guarded.min_lat,
        guarded.max_lon,
        guarded.max_lat,
        ${aiSelectSql}
      FROM guarded
      ${aiJoinSql}
    `;
    return db.prepare(selectGuardedCandidateRowsSql).all(
      minLon,
      minLat,
      maxLon,
      maxLat,
      ...compiledGuardRules.params,
      candidateLimit
    );
  }

  return {
    isPostgres,
    getBboxQueryMode,
    mapFilterDataRow,
    parseBboxInput,
    selectFilterDataRowsByKeys,
    selectFilterRowsByBbox,
    selectGuardedPostgresCandidateRowsByBbox,
    selectTagOnlyPostgresMatchRowsByBbox
  };
}

module.exports = {
  createBuildingFilterQueryService,
  mapFilterDataRow,
  parseBboxInput,
  resolveBboxQueryMode
};
