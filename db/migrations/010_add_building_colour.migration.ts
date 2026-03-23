function hasColumn(db, pragmaSql, columnName) {
  const columns = db.prepare(pragmaSql).all();
  return columns.some((column) => String(column?.name || '').trim() === columnName);
}

function up(db) {
  if (!hasColumn(db, 'PRAGMA local.table_info(architectural_info)', 'colour')) {
    db.exec('ALTER TABLE local.architectural_info ADD COLUMN colour TEXT;');
  }
  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'colour')) {
    db.exec('ALTER TABLE user_edits.building_user_edits ADD COLUMN colour TEXT;');
  }
}

module.exports = {
  up
};
