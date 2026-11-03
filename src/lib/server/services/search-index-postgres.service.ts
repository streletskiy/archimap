const SEARCH_INDEX_LOCK = 87423619;
const SEARCH_PROJECTION_VERSION = 2;
const SEARCH_COLUMNS = 'osm_key, osm_type, osm_id, name, address, style, architect, design_ref, local_priority, center_lon, center_lat, updated_at, search_tsv';
const SEARCH_QUEUE_RECLAIM_MIN_BYTES = 16 * 1024 * 1024;

// Caller owns a READ COMMITTED transaction and SEARCH_INDEX_LOCK. The queue is
// disposable only when empty; the generation sequence must never be reset.
async function reclaimEmptyPostgresSearchQueue(client, { minBytes = SEARCH_QUEUE_RECLAIM_MIN_BYTES }: LooseRecord = {}) {
  const state = await client.query(`SELECT
    pg_total_relation_size('public.building_data_changes') > $1 AS oversized,
    NOT EXISTS (SELECT 1 FROM public.building_data_changes) AS empty`, [minBytes]);
  if (!state.rows[0]?.oversized || !state.rows[0]?.empty) return false;
  await client.query('SAVEPOINT search_queue_compaction');
  try {
    // Never wait behind an importer (which may hold canonical locks). Writers
    // arriving after this lock wait only for this short empty-queue transaction.
    await client.query('LOCK TABLE public.building_data_changes IN ACCESS EXCLUSIVE MODE NOWAIT');
    const current = await client.query('SELECT EXISTS (SELECT 1 FROM public.building_data_changes) AS pending');
    if (current.rows[0].pending) {
      await client.query('ROLLBACK TO SAVEPOINT search_queue_compaction');
      await client.query('RELEASE SAVEPOINT search_queue_compaction');
      return false;
    }
    await client.query('TRUNCATE public.building_data_changes');
    await client.query('RELEASE SAVEPOINT search_queue_compaction');
    return true;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT search_queue_compaction');
    await client.query('RELEASE SAVEPOINT search_queue_compaction');
    if (error?.code === '55P03') return false;
    throw error;
  }
}

function buildPostgresSearchSourceSelect(joinSql = '') {
  return `WITH base AS MATERIALIZED (
    SELECT bc.osm_type, bc.osm_id,
      public.archimap_parse_tags(bc.tags_json) AS tags,
      CASE WHEN ai.osm_id IS NULL THEN public.archimap_parse_tags(bc.tags_json)
        ELSE public.archimap_search_tags(bc.tags_json, to_jsonb(ai)) END AS effective_tags,
      ai.name AS local_name, ai.address AS local_address, ai.style AS local_style,
      ai.architect AS local_architect, ai.design_ref AS local_design_ref,
      CASE WHEN ai.osm_id IS NULL THEN 0 ELSE 1 END AS local_priority,
      (bc.min_lon + bc.max_lon) / 2 AS center_lon, (bc.min_lat + bc.max_lat) / 2 AS center_lat
    FROM osm.building_contours bc ${joinSql}
    LEFT JOIN local.architectural_info ai USING (osm_type, osm_id)
  ), resolved AS (
    SELECT *,
      COALESCE(NULLIF(btrim(local_name), ''), NULLIF(btrim(tags ->> 'name'), ''),
        NULLIF(btrim(tags ->> 'name:ru'), ''), NULLIF(btrim(tags ->> 'official_name'), '')) AS name,
      COALESCE(NULLIF(btrim(local_address), ''), NULLIF(btrim(tags ->> 'addr:full'), ''),
        (SELECT string_agg(part, ', ' ORDER BY ord) FROM (
          SELECT DISTINCT ON (lower(part)) ord, part FROM (VALUES
            (1, NULLIF(btrim(tags ->> 'addr:postcode'), '')), (2, NULLIF(btrim(tags ->> 'addr:city'), '')),
            (3, NULLIF(btrim(tags ->> 'addr:place'), '')), (4, NULLIF(btrim(tags ->> 'addr:street'), '')),
            (5, NULLIF(btrim(tags ->> 'addr:housenumber'), ''))
          ) p(ord, part) WHERE part IS NOT NULL ORDER BY lower(part), ord
        ) address_parts)) AS address,
      COALESCE(NULLIF(btrim(local_style), ''), NULLIF(btrim(tags ->> 'building:architecture'), ''),
        NULLIF(btrim(tags ->> 'architecture'), ''), NULLIF(btrim(tags ->> 'style'), '')) AS style,
      COALESCE(NULLIF(btrim(local_architect), ''), NULLIF(btrim(tags ->> 'architect'), ''),
        NULLIF(btrim(tags ->> 'architect_name'), '')) AS architect,
      COALESCE(NULLIF(btrim(local_design_ref), ''), NULLIF(btrim(tags ->> 'design:ref'), ''),
        NULLIF(btrim(tags ->> 'design_ref'), '')) AS design_ref
    FROM base WHERE tags ? 'building' OR NOT (tags ? 'building:part' OR tags ? 'building_part')
  ), projected AS (
    SELECT osm_type || '/' || osm_id::text AS osm_key, osm_type, osm_id,
      name, address, style, architect, design_ref, local_priority, center_lon, center_lat, NOW() AS updated_at,
      setweight(to_tsvector('simple', concat_ws(' ', name, address, style, architect, design_ref)), 'A') ||
      setweight(jsonb_to_tsvector('simple', effective_tags, '["string","numeric","key"]'::jsonb), 'D') AS search_tsv
    FROM resolved
  ) SELECT ${SEARCH_COLUMNS} FROM projected WHERE search_tsv <> ''::tsvector`;
}

async function refreshPostgresSearchChanges(client, { batchSize = 5000, onBatch = null }: LooseRecord = {}) {
  let processed = 0;
  while (true) {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [SEARCH_INDEX_LOCK]);
      await client.query(`CREATE TEMP TABLE search_change_batch ON COMMIT DROP AS
        WITH oldest AS MATERIALIZED (SELECT osm_type, osm_id FROM public.building_data_changes
          ORDER BY generation LIMIT $1)
        SELECT pending.osm_type, pending.osm_id, pending.generation FROM public.building_data_changes pending
        JOIN oldest USING (osm_type, osm_id)
        ORDER BY pending.osm_type, pending.osm_id FOR UPDATE OF pending`, [batchSize]);
      const count = await client.query('SELECT count(*)::integer AS count FROM search_change_batch');
      const size = Number(count.rows[0].count);
      if (size === 0) {
        await reclaimEmptyPostgresSearchQueue(client);
        await client.query('COMMIT');
        break;
      }
      await client.query(`DELETE FROM public.building_search_source s USING search_change_batch c
        WHERE s.osm_type = c.osm_type AND s.osm_id = c.osm_id`);
      await client.query(`INSERT INTO public.building_search_source (${SEARCH_COLUMNS})
        ${buildPostgresSearchSourceSelect('JOIN search_change_batch changed USING (osm_type, osm_id)')}`);
      await client.query(`DELETE FROM public.building_data_changes pending USING search_change_batch consumed
        WHERE pending.osm_type = consumed.osm_type AND pending.osm_id = consumed.osm_id
          AND pending.generation = consumed.generation`);
      await client.query('COMMIT');
      processed += size;
      if (onBatch) await onBatch(size);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  return processed;
}

async function rebuildPostgresSearchIndex(client, { afterBuild = null }: LooseRecord = {}) {
  // Readers keep using the old table. This lock serializes only search writers.
  await client.query('SELECT pg_advisory_lock($1)', [SEARCH_INDEX_LOCK]);
  try {
    await client.query('DROP TABLE IF EXISTS public.building_search_source_next');
    await client.query('DROP TABLE IF EXISTS pg_temp.search_rebuild_ack');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      // Capture acknowledgements in exactly the same snapshot as the projection.
      await client.query(`CREATE TEMP TABLE search_rebuild_ack AS
        SELECT osm_type, osm_id, generation FROM public.building_data_changes`);
      await client.query(`CREATE TABLE public.building_search_source_next
        (LIKE public.building_search_source INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING STORAGE)`);
      await client.query(`INSERT INTO public.building_search_source_next (${SEARCH_COLUMNS}) ${buildPostgresSearchSourceSelect()}`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    await client.query('ALTER TABLE public.building_search_source_next ADD PRIMARY KEY (osm_key)');
    await client.query('CREATE INDEX search_next_osm ON public.building_search_source_next (osm_type, osm_id)');
    await client.query('CREATE INDEX search_next_tsv ON public.building_search_source_next USING GIN (search_tsv)');
    await client.query('CREATE INDEX search_next_style ON public.building_search_source_next (lower(style))');
    await client.query('ANALYZE public.building_search_source_next');
    if (afterBuild) await afterBuild();
    await client.query('BEGIN');
    try {
      await client.query('ALTER TABLE public.building_search_source RENAME TO building_search_source_previous');
      await client.query('ALTER TABLE public.building_search_source_next RENAME TO building_search_source');
      await client.query('DROP TABLE public.building_search_source_previous');
      await client.query('ALTER INDEX public.building_search_source_next_pkey RENAME TO building_search_source_pkey');
      await client.query('ALTER INDEX public.search_next_osm RENAME TO idx_building_search_source_osm');
      await client.query('ALTER INDEX public.search_next_tsv RENAME TO idx_building_search_source_tsv');
      await client.query('ALTER INDEX public.search_next_style RENAME TO idx_building_search_style');
      await client.query(`SELECT pending.osm_type, pending.osm_id FROM public.building_data_changes pending
        JOIN search_rebuild_ack consumed USING (osm_type, osm_id)
        WHERE pending.generation = consumed.generation
        ORDER BY pending.osm_type, pending.osm_id FOR UPDATE OF pending`);
      await client.query(`DELETE FROM public.building_data_changes pending USING search_rebuild_ack consumed
        WHERE pending.osm_type = consumed.osm_type AND pending.osm_id = consumed.osm_id
          AND pending.generation = consumed.generation`);
      await client.query(`UPDATE public.search_index_state SET projection_version = $1, updated_at = NOW() WHERE id = 1`, [SEARCH_PROJECTION_VERSION]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [SEARCH_INDEX_LOCK]);
  }
  // Changes committed during the snapshot build remain durably queued.
  await refreshPostgresSearchChanges(client);
}

module.exports = { SEARCH_INDEX_LOCK, SEARCH_PROJECTION_VERSION, buildPostgresSearchSourceSelect, refreshPostgresSearchChanges, rebuildPostgresSearchIndex, reclaimEmptyPostgresSearchQueue };
