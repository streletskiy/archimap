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
  if (!hasColumn(db, 'data_sync_regions', 'extract_source')) {
    db.exec('ALTER TABLE data_sync_regions ADD COLUMN extract_source TEXT;');
  }
  if (!hasColumn(db, 'data_sync_regions', 'extract_id')) {
    db.exec('ALTER TABLE data_sync_regions ADD COLUMN extract_id TEXT;');
  }
  if (!hasColumn(db, 'data_sync_regions', 'extract_label')) {
    db.exec('ALTER TABLE data_sync_regions ADD COLUMN extract_label TEXT;');
  }
  if (!hasColumn(db, 'data_sync_regions', 'extract_resolution_status')) {
    db.exec("ALTER TABLE data_sync_regions ADD COLUMN extract_resolution_status TEXT NOT NULL DEFAULT 'needs_resolution';");
  }
  if (!hasColumn(db, 'data_sync_regions', 'extract_resolution_error')) {
    db.exec('ALTER TABLE data_sync_regions ADD COLUMN extract_resolution_error TEXT;');
  }

  db.exec(`
    UPDATE data_sync_regions
    SET source_type = 'extract'
    WHERE COALESCE(TRIM(source_type), '') IN ('', 'extract_query');

    UPDATE data_sync_regions
    SET extract_resolution_status = 'resolved'
    WHERE COALESCE(TRIM(extract_id), '') <> ''
      AND COALESCE(TRIM(extract_source), '') <> '';
  `);
}

module.exports = {
  up
};
