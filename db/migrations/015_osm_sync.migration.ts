function hasColumn(db, pragmaSql, columnName) {
  const columns = db.prepare(pragmaSql).all();
  return columns.some((column) => String(column?.name || '').trim() === columnName);
}

function up(db) {
  if (!hasColumn(db, 'PRAGMA main.table_info(app_osm_settings)', 'client_id')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_osm_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        provider_name TEXT NOT NULL DEFAULT 'OpenStreetMap',
        auth_base_url TEXT NOT NULL DEFAULT 'https://www.openstreetmap.org',
        api_base_url TEXT NOT NULL DEFAULT 'https://api.openstreetmap.org',
        client_id TEXT,
        client_secret_enc TEXT,
        redirect_uri TEXT,
        access_token_enc TEXT,
        refresh_token_enc TEXT,
        token_type TEXT,
        scope TEXT,
        connected_user TEXT,
        connected_at TEXT,
        updated_by TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  if (!hasColumn(db, 'PRAGMA main.table_info(app_osm_oauth_states)', 'state')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_osm_oauth_states (
        state TEXT PRIMARY KEY,
        code_verifier TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );
    `);
  }

  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'source_osm_version')) {
    db.exec('ALTER TABLE user_edits.building_user_edits ADD COLUMN source_osm_version INTEGER;');
  }
  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'sync_status')) {
    db.exec("ALTER TABLE user_edits.building_user_edits ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'unsynced';");
  }
  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'sync_attempted_at')) {
    db.exec('ALTER TABLE user_edits.building_user_edits ADD COLUMN sync_attempted_at TEXT;');
  }
  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'sync_succeeded_at')) {
    db.exec('ALTER TABLE user_edits.building_user_edits ADD COLUMN sync_succeeded_at TEXT;');
  }
  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'sync_cleaned_at')) {
    db.exec('ALTER TABLE user_edits.building_user_edits ADD COLUMN sync_cleaned_at TEXT;');
  }
  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'sync_changeset_id')) {
    db.exec('ALTER TABLE user_edits.building_user_edits ADD COLUMN sync_changeset_id INTEGER;');
  }
  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'sync_summary_json')) {
    db.exec('ALTER TABLE user_edits.building_user_edits ADD COLUMN sync_summary_json TEXT;');
  }
  if (!hasColumn(db, 'PRAGMA user_edits.table_info(building_user_edits)', 'sync_error_text')) {
    db.exec('ALTER TABLE user_edits.building_user_edits ADD COLUMN sync_error_text TEXT;');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS user_edits.idx_user_building_edits_sync
    ON building_user_edits (osm_type, osm_id, sync_status, updated_at DESC);
  `);
}

module.exports = { up };
