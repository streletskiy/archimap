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
  const selectRawSearchSourceByBuilding = db.prepare(buildRawSearchSourceQuery({
    where: 'WHERE bc.osm_type = ? AND bc.osm_id = ?'
  }));
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
        sourceRow.architect || ''
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
