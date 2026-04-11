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
  if (!hasColumn(db, 'data_region_sync_runs', 'stage')) {
    db.exec('ALTER TABLE data_region_sync_runs ADD COLUMN stage TEXT;');
  }
  if (!hasColumn(db, 'data_region_sync_runs', 'stage_progress')) {
    db.exec('ALTER TABLE data_region_sync_runs ADD COLUMN stage_progress INTEGER;');
  }
  if (!hasColumn(db, 'data_region_sync_runs', 'stage_detail')) {
    db.exec('ALTER TABLE data_region_sync_runs ADD COLUMN stage_detail TEXT;');
  }
  if (!hasColumn(db, 'data_region_sync_runs', 'stage_updated_at')) {
    db.exec('ALTER TABLE data_region_sync_runs ADD COLUMN stage_updated_at TEXT;');
  }
  if (!hasColumn(db, 'data_region_sync_runs', 'cancel_requested')) {
    db.exec('ALTER TABLE data_region_sync_runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;');
  }
}

module.exports = {
  up
};
