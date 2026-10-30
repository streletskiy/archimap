function up(db) {
  const columns = db.prepare('PRAGMA table_info(data_sync_regions)').all();
  if (columns.length && !columns.some((column) => column.name === 'sync_failure_count')) {
    db.exec('ALTER TABLE data_sync_regions ADD COLUMN sync_failure_count INTEGER NOT NULL DEFAULT 0');
  }
}
module.exports = { up };
