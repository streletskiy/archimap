function hasColumn(db, pragmaSql, columnName) {
  const columns = db.prepare(pragmaSql).all();
  return columns.some((column) => String(column?.name || '').trim() === columnName);
}

function up(db) {
  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'edited_fields_json')) {
    db.exec('ALTER TABLE user_edits.building_user_edits ADD COLUMN edited_fields_json TEXT;');
  }
}

module.exports = {
  up
};
