function hasColumn(db, pragmaSql, columnName) {
  const columns = db.prepare(pragmaSql).all();
  return columns.some((column) => String(column?.name || '').trim() === columnName);
}

function up(db) {
  if (!hasColumn(db, 'PRAGMA local.table_info(architectural_info)', 'design_ref')) {
    db.exec('ALTER TABLE local.architectural_info ADD COLUMN design_ref TEXT;');
  }
  if (!hasColumn(db, 'PRAGMA local.table_info(architectural_info)', 'design_year')) {
    db.exec('ALTER TABLE local.architectural_info ADD COLUMN design_year INTEGER;');
  }
  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'design_ref')) {
    db.exec('ALTER TABLE user_edits.building_user_edits ADD COLUMN design_ref TEXT;');
  }
  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'design_year')) {
    db.exec('ALTER TABLE user_edits.building_user_edits ADD COLUMN design_year INTEGER;');
  }
}

module.exports = { up };
