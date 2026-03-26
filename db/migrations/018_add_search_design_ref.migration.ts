function hasColumn(db, pragmaSql, columnName) {
  const columns = db.prepare(pragmaSql).all();
  return columns.some((column) => String(column?.name || '').trim() === columnName);
}

function recreateSearchFts(db) {
  db.exec('DROP TABLE IF EXISTS building_search_fts;');
  db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS building_search_fts
USING fts5(
  osm_key UNINDEXED,
  name,
  address,
  style,
  architect,
  design_ref,
  tokenize = 'unicode61 remove_diacritics 2'
);
`);
}

function up(db) {
  const searchSourceHasDesignRef = hasColumn(db, 'PRAGMA table_info(building_search_source)', 'design_ref');
  if (!searchSourceHasDesignRef) {
    db.exec('ALTER TABLE building_search_source ADD COLUMN design_ref TEXT;');
  }

  const searchFtsHasDesignRef = hasColumn(db, 'PRAGMA table_info(building_search_fts)', 'design_ref');
  if (!searchSourceHasDesignRef || !searchFtsHasDesignRef) {
    recreateSearchFts(db);
  }
}

module.exports = {
  up
};
