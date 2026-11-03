const {
  BUILDING_SEARCH_FTS_DELETE_SQL,
  BUILDING_SEARCH_FTS_INSERT_SQL,
  BUILDING_SEARCH_SOURCE_DELETE_SQL,
  BUILDING_SEARCH_SOURCE_UPSERT_SQL,
  buildRawSearchSourceQuery,
  normalizeSearchSourceRow
} = require('./search-index-source.service');

function createSearchIndexRefreshService(options: LooseRecord = {}) {
  const { db } = options;

  if (!db) {
    throw new Error('createSearchIndexRefreshService: db is required');
  }

  const isPostgres = db.provider === 'postgres';
  if (isPostgres) {
    const { buildPostgresSearchSourceSelect, SEARCH_INDEX_LOCK } = require('./search-index-postgres.service');
    return {
      async refreshSearchIndexForBuilding(osmType, osmId) {
        const id = Number(osmId);
        if (!['way', 'relation'].includes(osmType) || !Number.isSafeInteger(id) || id <= 0) return;
        await db.transaction(async () => {
          await db.prepare('SELECT pg_advisory_xact_lock(?)').get(SEARCH_INDEX_LOCK);
          const pending = await db.prepare(`SELECT generation FROM public.building_data_changes
            WHERE osm_type = ? AND osm_id = ? FOR UPDATE`).get(osmType, id);
          await db.prepare('DELETE FROM public.building_search_source WHERE osm_type = ? AND osm_id = ?').run(osmType, id);
          // Both interpolated values have been restricted to an enum/safe integer above.
          const joinedTarget = `JOIN (VALUES ('${osmType}'::text, ${id}::bigint)) AS wanted(osm_type, osm_id) USING (osm_type, osm_id)`;
          await db.exec(`INSERT INTO public.building_search_source
            (osm_key, osm_type, osm_id, name, address, style, architect, design_ref, local_priority, center_lon, center_lat, updated_at, search_tsv)
            ${buildPostgresSearchSourceSelect(joinedTarget)}`);
          if (pending) {
            await db.prepare(`DELETE FROM public.building_data_changes
              WHERE osm_type = ? AND osm_id = ? AND generation = ?`).run(osmType, id, pending.generation);
          }
        })();
      }
    };
  }
  const selectRawSearchSourceByBuilding = db.prepare(
    buildRawSearchSourceQuery({
      where: 'WHERE bc.osm_type = ? AND bc.osm_id = ?'
    })
  );
  const upsertSearchSource = db.prepare(BUILDING_SEARCH_SOURCE_UPSERT_SQL);
  const deleteSearchSource = db.prepare(BUILDING_SEARCH_SOURCE_DELETE_SQL);
  const deleteSearchFts = !isPostgres ? db.prepare(BUILDING_SEARCH_FTS_DELETE_SQL) : null;
  const insertSearchFts = !isPostgres ? db.prepare(BUILDING_SEARCH_FTS_INSERT_SQL) : null;

  async function applySearchSourceRow(sourceRow) {
    await upsertSearchSource.run(sourceRow);
    if (!isPostgres) {
      await deleteSearchFts.run(sourceRow.osm_key);
      await insertSearchFts.run(
        sourceRow.osm_key,
        sourceRow.name || '',
        sourceRow.address || '',
        sourceRow.style || '',
        sourceRow.architect || '',
        sourceRow.design_ref || '',
        sourceRow.tags_text || ''
      );
    }
  }

  async function refreshSearchIndexForBuilding(osmType, osmId) {
    const rawRow = await selectRawSearchSourceByBuilding.get(osmType, osmId);
    const sourceRow = normalizeSearchSourceRow(rawRow);
    const osmKey = `${osmType}/${osmId}`;

    if (!sourceRow) {
      await deleteSearchSource.run(osmKey);
      if (!isPostgres) {
        await deleteSearchFts.run(osmKey);
      }
      return;
    }

    await applySearchSourceRow(sourceRow);
  }

  return {
    refreshSearchIndexForBuilding
  };
}

module.exports = {
  createSearchIndexRefreshService
};
