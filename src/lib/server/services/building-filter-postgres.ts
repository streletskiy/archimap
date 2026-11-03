const {
  collectRequiredArchiColumns,
  compilePostgresFilterRulesPredicate,
  trimSql
} = require('../utils/filter-sql-builder');
const { sanitizeEditedFields } = require('./edits.service');

const PERSONAL_FIELDS = [
  'name',
  'address',
  'levels',
  'year_built',
  'architect',
  'style',
  'design',
  'design_ref',
  'design_year',
  'material',
  'roof_shape',
  'colour',
  'archimap_description'
];

function derivedLevelsSql(tags = 'source.tags_jsonb') {
  const firstNumber = (keys) =>
    `COALESCE(${keys
      .map(
        (key) =>
          `substring(replace(CASE WHEN jsonb_typeof(${tags}->'${key}') IN ('array', 'object') THEN osm.filter_json_text(${tags}->'${key}', ',') ELSE ${tags}->>'${key}' END, ',', '.') from '-?[0-9]+(?:[.][0-9]+)?')::numeric`
      )
      .join(', ')})`;
  // Keep each parsed value behind an evaluation barrier. PostgreSQL otherwise
  // expands these aliases into every CASE branch and reparses each tag many times.
  // Most buildings have explicit levels or no height, so defer the other inputs.
  return `(SELECT CASE
    WHEN levels >= 0 AND levels <= 300 AND levels = trunc(levels) THEN levels::integer::text
    ELSE (SELECT CASE WHEN height > 0 THEN (
      SELECT CASE WHEN height > base_height
        AND greatest(1, floor((height - base_height) / 3.2 + 0.5)) <= 300
        THEN greatest(1, floor((height - base_height) / 3.2 + 0.5))::integer::text
        ELSE NULL END
      FROM (SELECT greatest(COALESCE(${firstNumber(['building:min_height', 'min_height'])}, 0),
        COALESCE(${firstNumber(['building:min_level', 'min_level'])}, 0) * 3.2, 0) AS base_height OFFSET 0) minimum_height
    ) ELSE NULL END
    FROM (SELECT ${firstNumber(['building:height', 'height'])} AS height OFFSET 0) height_value)
    END FROM (SELECT ${firstNumber(['building:levels', 'levels'])} AS levels OFFSET 0) level_value)`;
}

async function loadPersonalFilterOverrides(db, actorKey, bbox, requiredColumns) {
  if (!actorKey || actorKey === 'anon' || requiredColumns.length === 0) return [];
  const rows = await db
    .prepare(
      `
    WITH env AS (SELECT ST_MakeEnvelope(?, ?, ?, ?, 4326) AS geom)
    SELECT DISTINCT ON (ue.osm_type, ue.osm_id)
      ue.osm_type, ue.osm_id, ue.edited_fields_json,
      ${[...PERSONAL_FIELDS, 'material_concrete'].map((field) => `ue.${field}`).join(', ')}
    FROM user_edits.building_user_edits ue
    JOIN osm.building_contours bc ON bc.osm_type = ue.osm_type AND bc.osm_id = ue.osm_id
    JOIN env ON bc.geom && env.geom
    WHERE lower(trim(ue.created_by)) = ? AND ue.status IN ('pending', 'rejected')
      AND ST_Intersects(bc.geom, env.geom)
    ORDER BY ue.osm_type, ue.osm_id, ue.id DESC
  `
    )
    .all(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat, actorKey);
  return rows.map((row) => {
    const parsedFields = sanitizeEditedFields(row.edited_fields_json);
    const overrides: LooseRecord = {};
    for (const field of parsedFields.length ? parsedFields : PERSONAL_FIELDS) {
      overrides[field] = row[field] ?? null;
      if (field === 'material') overrides.material_concrete = row.material_concrete ?? null;
      if (field === 'archimap_description') overrides.description = row.archimap_description ?? null;
    }
    // Do not send unrelated edit values or source geometry through the query.
    return {
      osm_type: row.osm_type,
      osm_id: row.osm_id,
      overrides: Object.fromEntries(Object.entries(overrides).filter(([field]) => requiredColumns.includes(field)))
    };
  });
}

async function selectPostgresFilterMatches(db, { bbox, requests, actorKey = 'anon', markerGrid = null }) {
  const columns = collectRequiredArchiColumns(requests.flatMap((request) => request.rules));
  const needsLevels = columns.includes('levels');
  const personal = await loadPersonalFilterOverrides(db, actorKey, bbox, columns);
  const hasPersonal = personal.length > 0;
  const params = [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat];
  if (hasPersonal) params.push(JSON.stringify(personal));
  const normalizedMaterial = `lower(${trimSql('ai.material')})`;
  const concreteVariant = `${normalizedMaterial} IN ('concrete_panels', 'concrete_blocks', 'concrete_monolith')`;
  function baseColumn(column) {
    if (column === 'material')
      return `CASE WHEN ${concreteVariant} THEN 'concrete' ELSE COALESCE(NULLIF(${normalizedMaterial}, ''), ai.material) END`;
    if (column === 'material_concrete')
      return `CASE WHEN ${concreteVariant} THEN substring(${normalizedMaterial} from 10) ELSE ai.material_concrete END`;
    if (column === 'archimap_description')
      return `COALESCE(NULLIF(ai.archimap_description, ''), NULLIF(ai.description, ''))`;
    return `ai.${column}::text`;
  }
  const sourceColumns = columns.map((column) => {
    const base = baseColumn(column);
    return `${hasPersonal ? `CASE WHEN jsonb_exists(personal.overrides, '${column}') THEN personal.overrides->>'${column}' ELSE ${base} END` : base} AS ${column}`;
  });
  if (needsLevels) sourceColumns.push('ai.levels::text AS base_levels');
  const projection = sourceColumns.length ? `, ${sourceColumns.join(', ')}` : '';
  // Level fallbacks reference several keys and their result more than once.
  // Materialize both steps to parse JSON/derive levels once, while simple tag
  // requests retain predicate pushdown and can stop at their result limit.
  const base = `
    WITH env AS (SELECT ST_MakeEnvelope(?, ?, ?, ?, 4326) AS geom)
    ${hasPersonal ? ', personal AS (SELECT * FROM jsonb_to_recordset(?::jsonb) AS p(osm_type text, osm_id bigint, overrides jsonb))' : ''}
    , source AS ${needsLevels ? 'MATERIALIZED' : 'NOT MATERIALIZED'} (
      SELECT bc.osm_type, bc.osm_id, bc.min_lon, bc.min_lat, bc.max_lon, bc.max_lat,
        COALESCE(NULLIF(bc.tags_json, '')::jsonb, '{}'::jsonb) AS tags_jsonb
        ${projection}
      FROM osm.building_contours bc
      JOIN env ON bc.geom && env.geom
      ${columns.length ? 'LEFT JOIN local.architectural_info ai ON ai.osm_type = bc.osm_type AND ai.osm_id = bc.osm_id' : ''}
      ${hasPersonal ? 'LEFT JOIN personal ON personal.osm_type = bc.osm_type AND personal.osm_id = bc.osm_id' : ''}
      WHERE ST_Intersects(bc.geom, env.geom)
    ), effective AS ${needsLevels || requests.length > 1 ? 'MATERIALIZED' : 'NOT MATERIALIZED'} (
      SELECT source.* ${needsLevels ? `, COALESCE(base_levels, ${derivedLevelsSql()}) AS item_levels` : ''}
      FROM source
    )
  `;
  const selects = requests
    .map((request, index) => {
      const predicate = compilePostgresFilterRulesPredicate(request.rules, { rowAlias: 'effective' });
      params.push(...predicate.params);
      if (markerGrid) {
        const grid = markerGrid;
        const b = grid.bbox;
        const cellSize = grid.legacyCellSize;
        // Bounds and grid dimensions are already finite numbers validated by the service.
        const x = b
          ? `greatest(0, least(${grid.columns - 1}, floor(((min_lon + max_lon) / 2 - ${b.west}) / ${b.width / grid.columns})))`
          : `floor(((min_lon + max_lon) / 2 + 180) / ${cellSize})`;
        const y = b
          ? `greatest(0, least(${grid.rows - 1}, floor(((min_lat + max_lat) / 2 - ${b.south}) / ${b.height / grid.rows})))`
          : `floor(((min_lat + max_lat) / 2 + 90) / ${cellSize})`;
        return `(SELECT ${index} AS request_index, ${x} AS cell_x, ${y} AS cell_y,
        count(*)::bigint AS cell_count, sum(count(*)) OVER ()::bigint AS total_count
        FROM effective WHERE ${predicate.sql} GROUP BY cell_x, cell_y ORDER BY cell_x, cell_y LIMIT 50001)`;
      }
      params.push(Math.trunc(request.maxResults) + 1);
      return `(SELECT ${index} AS request_index, osm_type, osm_id, min_lon, min_lat, max_lon, max_lat
      FROM effective WHERE ${predicate.sql} LIMIT ?)`;
    })
    .filter(Boolean);
  if (!selects.length) return [];
  return db.prepare(base + selects.join('\nUNION ALL\n')).all(...params);
}

module.exports = { selectPostgresFilterMatches };
