require('dotenv').config({ quiet: true });

const path = require('path');
const Database = require('better-sqlite3');

const reason = String(process.env.FILTER_TAG_KEYS_REBUILD_REASON || 'manual').trim() || 'manual';
const dbPath = String(process.env.ARCHIMAP_DB_PATH || path.join(__dirname, '..', 'data', 'archimap.db')).trim();
const osmDbPath = String(process.env.OSM_DB_PATH || path.join(__dirname, '..', 'data', 'osm.db')).trim();

function run() {
  const startedAt = Date.now();
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.prepare(`ATTACH DATABASE ? AS osm`).run(osmDbPath);
  db.exec('PRAGMA osm.journal_mode = WAL;');
  db.exec('PRAGMA osm.synchronous = NORMAL;');

  try {
    db.exec(`
CREATE TABLE IF NOT EXISTS filter_tag_keys_cache (
  tag_key TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

    console.log(`[filter-tags] rebuild started (${reason})`);
    const keys = db.prepare(`
      SELECT DISTINCT trim(je.key) AS tag_key
      FROM osm.building_contours bc,
           json_each(CASE WHEN json_valid(bc.tags_json) THEN bc.tags_json ELSE '{}' END) AS je
      WHERE je.key IS NOT NULL
        AND trim(je.key) <> ''
      ORDER BY tag_key COLLATE NOCASE
    `).all().map((row) => String(row?.tag_key || '').trim()).filter(Boolean);

    const tx = db.transaction(() => {
      db.exec('DELETE FROM filter_tag_keys_cache;');
      const insert = db.prepare(`
        INSERT INTO filter_tag_keys_cache (tag_key, updated_at)
        VALUES (?, datetime('now'))
      `);
      for (const key of keys) {
        insert.run(key);
      }
    });
    tx();

    console.log(`[filter-tags] rebuild completed: ${keys.length} keys in ${Date.now() - startedAt}ms`);
  } finally {
    db.close();
  }
}

try {
  run();
} catch (error) {
  console.error(`[filter-tags] rebuild failed: ${String(error.message || error)}`);
  process.exit(1);
}
