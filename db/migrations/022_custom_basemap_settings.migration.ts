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
  if (!hasColumn(db, 'app_general_settings', 'custom_basemap_url')) {
    db.exec("ALTER TABLE app_general_settings ADD COLUMN custom_basemap_url TEXT NOT NULL DEFAULT '';");
  }
  if (!hasColumn(db, 'app_general_settings', 'custom_basemap_api_key')) {
    db.exec('ALTER TABLE app_general_settings ADD COLUMN custom_basemap_api_key TEXT;');
  }
}

module.exports = {
  up
};
