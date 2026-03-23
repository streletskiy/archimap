function hasColumn(db, pragmaSql, columnName) {
  const columns = db.prepare(pragmaSql).all();
  return columns.some((column) => String(column?.name || '').trim() === columnName);
}

function up(db) {
  if (!hasColumn(db, 'PRAGMA local.table_info(architectural_info)', 'material_concrete')) {
    db.exec('ALTER TABLE local.architectural_info ADD COLUMN material_concrete TEXT;');
  }
  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'material_concrete')) {
    db.exec('ALTER TABLE user_edits.building_user_edits ADD COLUMN material_concrete TEXT;');
  }
}

module.exports = { up };
