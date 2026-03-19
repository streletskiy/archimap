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

function hasIndex(db, indexName) {
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
    CREATE TABLE IF NOT EXISTS data_filter_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      preset_key TEXT NOT NULL,
      preset_name TEXT NOT NULL,
      preset_description TEXT,
      layers_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_data_filter_presets_key
    ON data_filter_presets (preset_key);

    CREATE INDEX IF NOT EXISTS idx_data_filter_presets_name
    ON data_filter_presets (preset_name, id);
  `);

  if (!hasColumn(db, 'data_filter_presets', 'updated_by')) {
    db.exec('ALTER TABLE data_filter_presets ADD COLUMN updated_by TEXT;');
  }
  if (!hasColumn(db, 'data_filter_presets', 'preset_description')) {
    db.exec('ALTER TABLE data_filter_presets ADD COLUMN preset_description TEXT;');
  }
  if (!hasIndex(db, 'idx_data_filter_presets_key')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_data_filter_presets_key
      ON data_filter_presets (preset_key);
    `);
  }
  if (!hasIndex(db, 'idx_data_filter_presets_name')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_data_filter_presets_name
      ON data_filter_presets (preset_name, id);
    `);
  }
}

module.exports = {
  up
};
