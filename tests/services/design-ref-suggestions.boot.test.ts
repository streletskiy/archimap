const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createDesignRefSuggestionsBoot } = require('../../src/lib/server/boot/design-ref-suggestions.boot');

function createDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    ATTACH ':memory:' AS local;
    ATTACH ':memory:' AS user_edits;
    ATTACH ':memory:' AS osm;

    CREATE TABLE local.architectural_info (
      osm_type TEXT,
      osm_id INTEGER,
      design_ref TEXT
    );

    CREATE TABLE user_edits.building_user_edits (
      id INTEGER PRIMARY KEY,
      design_ref TEXT
    );

    CREATE TABLE osm.building_contours (
      osm_type TEXT,
      osm_id INTEGER,
      tags_json TEXT
    );
  `);

  return {
    prepare(sql) {
      const statement = sqlite.prepare(String(sql || ''));
      return {
        all: (...args) => statement.all(...args),
        run: (...args) => statement.run(...args)
      };
    }
  };
}

test('design ref suggestions boot caches distinct values from local edits and OSM tags', async () => {
  const db = createDb();
  db.prepare(`INSERT INTO local.architectural_info (osm_type, osm_id, design_ref) VALUES (?, ?, ?)`)
    .run('way', 1, '1-447С-43');
  db.prepare(`INSERT INTO user_edits.building_user_edits (id, design_ref) VALUES (?, ?)`)
    .run(1, '1-447С-43');
  db.prepare(`INSERT INTO user_edits.building_user_edits (id, design_ref) VALUES (?, ?)`)
    .run(2, ' II-18 ');
  db.prepare(`INSERT INTO osm.building_contours (osm_type, osm_id, tags_json) VALUES (?, ?, ?)`)
    .run('way', 2, JSON.stringify({ 'design:ref': '87-0145' }));

  const boot = createDesignRefSuggestionsBoot({
    db,
    dbProvider: 'sqlite',
    logger: { info() {}, error() {} }
  });

  const suggestions = await boot.refreshDesignRefSuggestionsCache('test');
  assert.deepEqual(suggestions, ['1-447С-43', '87-0145', 'II-18']);
  assert.deepEqual(await boot.getDesignRefSuggestionsCached(), ['1-447С-43', '87-0145', 'II-18']);
});
