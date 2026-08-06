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

function up(db) {
  if (!hasTable(db, 'data_region_source_snapshots')) {
    db.exec(`
      CREATE TABLE data_region_source_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        region_id INTEGER NOT NULL REFERENCES data_sync_regions(id) ON DELETE CASCADE,
        extract_source TEXT,
        extract_id TEXT,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        source_mtime TEXT,
        local_path TEXT,
        imported_feature_count INTEGER,
        pmtiles_bytes INTEGER,
        is_active INTEGER NOT NULL DEFAULT 0,
        superseded_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_region_source_snapshots_region_created ON data_region_source_snapshots (region_id, created_at DESC);'
    );
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS ux_region_source_snapshots_active ON data_region_source_snapshots (region_id) WHERE is_active = 1;"
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_region_source_snapshots_region_sha ON data_region_source_snapshots (region_id, sha256);'
    );
  }
}

module.exports = {
  up
};
