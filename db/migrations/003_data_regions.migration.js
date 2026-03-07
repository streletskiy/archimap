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
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_data_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      env_bootstrap_completed INTEGER NOT NULL DEFAULT 0,
      env_bootstrap_source TEXT,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS data_sync_regions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'extract_query',
      source_value TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      auto_sync_enabled INTEGER NOT NULL DEFAULT 1,
      auto_sync_on_start INTEGER NOT NULL DEFAULT 0,
      auto_sync_interval_hours INTEGER NOT NULL DEFAULT 168,
      pmtiles_min_zoom INTEGER NOT NULL DEFAULT 13,
      pmtiles_max_zoom INTEGER NOT NULL DEFAULT 16,
      source_layer TEXT NOT NULL DEFAULT 'buildings',
      last_sync_started_at TEXT,
      last_sync_finished_at TEXT,
      last_sync_status TEXT NOT NULL DEFAULT 'idle',
      last_sync_error TEXT,
      last_successful_sync_at TEXT,
      next_sync_at TEXT,
      bounds_west REAL,
      bounds_south REAL,
      bounds_east REAL,
      bounds_north REAL,
      last_feature_count INTEGER,
      updated_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_data_sync_regions_enabled_next
    ON data_sync_regions (enabled, next_sync_at);

    CREATE TABLE IF NOT EXISTS data_region_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      region_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      trigger_reason TEXT NOT NULL DEFAULT 'manual',
      requested_by TEXT,
      requested_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      error_text TEXT,
      imported_feature_count INTEGER,
      active_feature_count INTEGER,
      orphan_deleted_count INTEGER,
      pmtiles_bytes INTEGER,
      bounds_west REAL,
      bounds_south REAL,
      bounds_east REAL,
      bounds_north REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (region_id) REFERENCES data_sync_regions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_data_region_sync_runs_region_id
    ON data_region_sync_runs (region_id, id DESC);

    CREATE INDEX IF NOT EXISTS idx_data_region_sync_runs_status
    ON data_region_sync_runs (status, id DESC);

    CREATE TABLE IF NOT EXISTS data_region_memberships (
      region_id INTEGER NOT NULL,
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (region_id, osm_type, osm_id),
      FOREIGN KEY (region_id) REFERENCES data_sync_regions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_data_region_memberships_feature
    ON data_region_memberships (osm_type, osm_id);
  `);

  if (!hasColumn(db, 'data_sync_regions', 'last_feature_count')) {
    db.exec('ALTER TABLE data_sync_regions ADD COLUMN last_feature_count INTEGER;');
  }
}

module.exports = {
  up
};
