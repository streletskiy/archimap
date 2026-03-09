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
    if (!hasColumn(db, 'data_region_sync_runs', 'db_bytes')) {
        db.exec('ALTER TABLE data_region_sync_runs ADD COLUMN db_bytes INTEGER;');
        db.exec('ALTER TABLE data_region_sync_runs ADD COLUMN db_bytes_approximate INTEGER DEFAULT 0;');
    }
}

module.exports = {
    up
};
