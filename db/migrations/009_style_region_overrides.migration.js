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

function hasUniqueIndex(db, indexName) {
  const row = db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'index' AND name = ?
    LIMIT 1
  `).get(indexName);
  return Boolean(row);
}

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS data_style_region_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      region_pattern TEXT NOT NULL,
      style_key TEXT NOT NULL,
      is_allowed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_data_style_region_overrides_pattern_style
    ON data_style_region_overrides (region_pattern, style_key);

    CREATE INDEX IF NOT EXISTS idx_data_style_region_overrides_style_key
    ON data_style_region_overrides (style_key, id DESC);
  `);

  if (!hasColumn(db, 'data_style_region_overrides', 'updated_by')) {
    db.exec('ALTER TABLE data_style_region_overrides ADD COLUMN updated_by TEXT;');
  }

  if (!hasUniqueIndex(db, 'idx_data_style_region_overrides_pattern_style')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_data_style_region_overrides_pattern_style
      ON data_style_region_overrides (region_pattern, style_key);
    `);
  }
}

module.exports = {
  up
};
