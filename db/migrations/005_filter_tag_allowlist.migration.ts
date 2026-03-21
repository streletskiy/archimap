function hasTable(db, tableName) {
  const row = db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName);
  return Boolean(row);
}

function hasColumn(db, tableName, columnName) {
  if (!hasTable(db, tableName)) return false;
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => String(column?.name || '').trim() === columnName);
}

function up(db) {
  if (!hasColumn(db, 'app_data_settings', 'filter_tag_allowlist_json')) {
    db.exec('ALTER TABLE app_data_settings ADD COLUMN filter_tag_allowlist_json TEXT;');
  }
}

module.exports = {
  up
};
