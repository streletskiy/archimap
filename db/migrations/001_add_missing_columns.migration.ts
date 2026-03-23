function hasColumn(db, pragmaSql, columnName) {
  const columns = db.prepare(pragmaSql).all();
  return columns.some((column) => String(column?.name || '').trim() === columnName);
}

function up(db) {
  if (!hasColumn(db, 'PRAGMA local.table_info(architectural_info)', 'description')) {
    db.exec('ALTER TABLE local.architectural_info ADD COLUMN description TEXT;');
  }
  if (!hasColumn(db, 'PRAGMA local.table_info(architectural_info)', 'archimap_description')) {
    db.exec('ALTER TABLE local.architectural_info ADD COLUMN archimap_description TEXT;');
  }
  if (!hasColumn(db, 'PRAGMA table_info(building_search_source)', 'local_priority')) {
    db.exec('ALTER TABLE building_search_source ADD COLUMN local_priority INTEGER NOT NULL DEFAULT 0;');
  }
}

module.exports = {
  up
};
