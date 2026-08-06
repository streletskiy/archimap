function hasTable(db, tableName) {
  const row = db
    .prepare(
      `
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `
    )
    .get(tableName);
  return Boolean(row);
}

function hasColumn(db, tableName, columnName) {
  if (!hasTable(db, tableName)) return false;
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => String(column?.name || '').trim() === columnName);
}

function up(db) {
  if (!hasColumn(db, 'data_sync_regions', 'source_data_updated_at')) {
    db.exec('ALTER TABLE data_sync_regions ADD COLUMN source_data_updated_at TEXT;');
  }
}

module.exports = {
  up
};
