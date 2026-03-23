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
  if (!hasTable(db, 'data_filter_presets')) return;
  if (!hasColumn(db, 'data_filter_presets', 'preset_name_i18n_json')) {
    db.exec('ALTER TABLE data_filter_presets ADD COLUMN preset_name_i18n_json TEXT;');
  }
}

module.exports = {
  up
};
