function hasColumn(db, pragmaSql, columnName) {
  const columns = db.prepare(pragmaSql).all();
  return columns.some((column) => String(column?.name || '').trim() === columnName);
}

function up(db) {
  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'source_geometry_json')) {
    db.exec('ALTER TABLE user_edits.building_user_edits ADD COLUMN source_geometry_json TEXT;');
  }

  db.exec('CREATE INDEX IF NOT EXISTS user_edits.idx_user_building_edits_target ON building_user_edits (osm_type, osm_id, updated_at DESC);');
}

module.exports = {
  up
};
