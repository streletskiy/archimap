const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createBuildingEditsService } = require('../../services/building-edits.service');
const { normalizeUserEditStatus } = require('../../services/edits.service');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    ATTACH ':memory:' AS user_edits;
    ATTACH ':memory:' AS osm;
    ATTACH ':memory:' AS local;

    CREATE TABLE user_edits.building_user_edits (
      id INTEGER PRIMARY KEY,
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      name TEXT,
      style TEXT,
      levels INTEGER,
      year_built INTEGER,
      architect TEXT,
      address TEXT,
      archimap_description TEXT,
      status TEXT NOT NULL,
      admin_comment TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      merged_by TEXT,
      merged_at TEXT,
      merged_fields_json TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE osm.building_contours (
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      tags_json TEXT
    );

    CREATE TABLE local.architectural_info (
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      name TEXT,
      style TEXT,
      levels INTEGER,
      year_built INTEGER,
      architect TEXT,
      address TEXT,
      description TEXT,
      archimap_description TEXT,
      updated_by TEXT,
      updated_at TEXT
    );
  `);
  return db;
}

test('buildChangesFromRows uses OSM fallback for empty merged name/address', () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json)
    VALUES (?, ?, ?)
  `).run(
    'way',
    1001,
    JSON.stringify({
      name: 'Дом Мельникова',
      'addr:city': 'Москва',
      'addr:street': 'Кривоарбатский переулок',
      'addr:housenumber': '10',
      architect: 'Константин Мельников'
    })
  );

  db.prepare(`
    INSERT INTO local.architectural_info (
      osm_type, osm_id, name, style, levels, year_built, architect, address, description, archimap_description, updated_by, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    'way',
    1001,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    'admin@example.com'
  );

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, style, levels, year_built, architect, address, archimap_description, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    1,
    'way',
    1001,
    'user@example.com',
    'Дом Мельникова',
    null,
    null,
    null,
    'Константин Мельников',
    'Москва, Кривоарбатский переулок, 10',
    null,
    'pending'
  );

  const items = service.getUserEditsList({ status: 'pending', limit: 10 });
  assert.equal(items.length, 1);

  const fields = new Set((items[0].changes || []).map((change) => String(change.field || '')));
  assert.equal(fields.has('name'), false);
  assert.equal(fields.has('address'), false);
  assert.equal(fields.has('architect'), false);
});

test('buildChangesFromRows does not report levels diff for numeric-equivalent values', () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json)
    VALUES (?, ?, ?)
  `).run(
    'way',
    2002,
    JSON.stringify({
      name: 'Тестовый дом',
      'building:levels': '1'
    })
  );

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, style, levels, year_built, architect, address, archimap_description, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    2,
    'way',
    2002,
    'user@example.com',
    null,
    null,
    1,
    null,
    null,
    null,
    null,
    'pending'
  );

  const items = service.getUserEditsList({ status: 'pending', limit: 10 });
  assert.equal(items.length, 1);

  const fields = new Set((items[0].changes || []).map((change) => String(change.field || '')));
  assert.equal(fields.has('levels'), false);
});

