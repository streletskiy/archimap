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
  if (!hasColumn(db, 'data_sync_regions', 'parent_region_id')) {
    db.exec(
      'ALTER TABLE data_sync_regions ADD COLUMN parent_region_id INTEGER REFERENCES data_sync_regions(id) ON DELETE CASCADE;'
    );
  }
  if (!hasColumn(db, 'data_sync_regions', 'region_kind')) {
    db.exec("ALTER TABLE data_sync_regions ADD COLUMN region_kind TEXT NOT NULL DEFAULT 'standalone';");
  }
  if (!hasColumn(db, 'data_sync_regions', 'order_in_parent')) {
    db.exec('ALTER TABLE data_sync_regions ADD COLUMN order_in_parent INTEGER;');
  }
  if (!hasColumn(db, 'data_sync_regions', 'visible_in_admin')) {
    db.exec('ALTER TABLE data_sync_regions ADD COLUMN visible_in_admin INTEGER NOT NULL DEFAULT 1;');
  }
  if (!hasColumn(db, 'data_sync_regions', 'country_code')) {
    db.exec('ALTER TABLE data_sync_regions ADD COLUMN country_code TEXT;');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_data_sync_regions_parent
    ON data_sync_regions (parent_region_id, order_in_parent);
  `);

  if (!hasColumn(db, 'data_region_sync_runs', 'parent_run_id')) {
    db.exec('ALTER TABLE data_region_sync_runs ADD COLUMN parent_run_id INTEGER;');
  }
  if (!hasColumn(db, 'data_region_sync_runs', 'subregion_index')) {
    db.exec('ALTER TABLE data_region_sync_runs ADD COLUMN subregion_index INTEGER;');
  }
  if (!hasColumn(db, 'data_region_sync_runs', 'subregion_total')) {
    db.exec('ALTER TABLE data_region_sync_runs ADD COLUMN subregion_total INTEGER;');
  }
  if (!hasColumn(db, 'data_region_sync_runs', 'current_subregion_id')) {
    db.exec('ALTER TABLE data_region_sync_runs ADD COLUMN current_subregion_id INTEGER;');
  }
  if (!hasColumn(db, 'data_region_sync_runs', 'current_subregion_name')) {
    db.exec('ALTER TABLE data_region_sync_runs ADD COLUMN current_subregion_name TEXT;');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_data_region_sync_runs_parent
    ON data_region_sync_runs (parent_run_id, id);
  `);
}

module.exports = {
  up
};
