const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createBuildingEditsService } = require('../../src/lib/server/services/building-edits.service');
const { normalizeUserEditStatus } = require('../../src/lib/server/services/edits.service');

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
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
      material TEXT,
      colour TEXT,
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
      source_tags_json TEXT,
      source_osm_updated_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE osm.building_contours (
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      tags_json TEXT,
      updated_at TEXT
    );

    CREATE TABLE local.architectural_info (
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      name TEXT,
      style TEXT,
      material TEXT,
      colour TEXT,
      levels INTEGER,
      year_built INTEGER,
      architect TEXT,
      address TEXT,
      description TEXT,
      archimap_description TEXT,
      updated_by TEXT,
      updated_at TEXT,
      UNIQUE (osm_type, osm_id)
    );
  `);
  return {
    provider: 'sqlite',
    prepare(sql) {
      const statement = sqlite.prepare(String(sql || ''));
      return {
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
        run: (...args) => statement.run(...args)
      };
    },
    exec(sql) {
      sqlite.exec(String(sql || ''));
    },
    transaction(fn) {
      return async (...args) => {
        sqlite.exec('BEGIN');
        try {
          const result = await fn(...args);
          sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      };
    }
  };
}

test('buildChangesFromRows uses OSM fallback for empty merged name/address', async () => {
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

  const items = await service.getUserEditsList({ status: 'pending', limit: 10 });
  assert.equal(items.length, 1);

  const fields = new Set((items[0].changes || []).map((change) => String(change.field || '')));
  assert.equal(fields.has('name'), false);
  assert.equal(fields.has('address'), false);
  assert.equal(fields.has('architect'), false);
});

test('buildChangesFromRows does not report levels diff for numeric-equivalent values', async () => {
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

  const items = await service.getUserEditsList({ status: 'pending', limit: 10 });
  assert.equal(items.length, 1);

  const fields = new Set((items[0].changes || []).map((change) => String(change.field || '')));
  assert.equal(fields.has('levels'), false);
});

test('getUserEditsList marks accepted edit as orphaned when contour is missing', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO local.architectural_info (
      osm_type, osm_id, name, updated_by, updated_at
    )
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run('way', 3003, 'Старый дом', 'admin@example.com');

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(3, 'way', 3003, 'user@example.com', 'Старый дом', 'accepted');

  const items = await service.getUserEditsList({ status: 'accepted', limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0].osmPresent, false);
  assert.equal(items[0].orphaned, true);
  assert.equal(items[0].hasMergedLocal, true);
});

test('getUserEditDetailsById marks edit as drifted when OSM tags changed after submission', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json)
    VALUES (?, ?, ?)
  `).run('way', 4004, JSON.stringify({ name: 'Новое имя' }));

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, status, source_tags_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(4, 'way', 4004, 'user@example.com', 'Локальное имя', 'pending', JSON.stringify({ name: 'Старое имя' }));

  const item = await service.getUserEditDetailsById(4);
  assert.equal(item?.osmPresent, true);
  assert.equal(item?.sourceOsmChanged, true);
});

test('reassignUserEdit moves accepted local info to another building', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json)
    VALUES (?, ?, ?), (?, ?, ?)
  `).run(
    'way',
    5005,
    JSON.stringify({ name: 'Исходное здание' }),
    'way',
    6006,
    JSON.stringify({ name: 'Целевое здание' })
  );

  db.prepare(`
    INSERT INTO local.architectural_info (
      osm_type, osm_id, name, architect, updated_by, updated_at
    )
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run('way', 5005, 'Локальное имя', 'Локальный архитектор', 'admin@example.com');

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, architect, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(5, 'way', 5005, 'user@example.com', 'Локальное имя', 'Локальный архитектор', 'accepted');

  const updated = await service.reassignUserEdit(5, { osmType: 'way', osmId: 6006 }, { actor: 'admin@example.com' });
  assert.equal(updated?.osmType, 'way');
  assert.equal(updated?.osmId, 6006);

  const moved = db.prepare(`
    SELECT name, architect
    FROM local.architectural_info
    WHERE osm_type = ? AND osm_id = ?
  `).get('way', 6006);
  assert.equal(moved?.name, 'Локальное имя');
  assert.equal(moved?.architect, 'Локальный архитектор');

  const source = db.prepare(`
    SELECT 1
    FROM local.architectural_info
    WHERE osm_type = ? AND osm_id = ?
  `).get('way', 5005);
  assert.equal(source, undefined);
});

test('deleteUserEdit removes pending edit history row', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(6, 'way', 7007, 'user@example.com', 'Черновик', 'pending');

  const deleted = await service.deleteUserEdit(6);
  assert.equal(deleted?.editId, 6);
  assert.equal(deleted?.status, 'pending');
  assert.equal(deleted?.deletedMergedLocal, false);

  const row = db.prepare(`
    SELECT 1
    FROM user_edits.building_user_edits
    WHERE id = ?
  `).get(6);
  assert.equal(row, undefined);
});

test('deleteUserEdit removes lone accepted edit together with merged local data', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO local.architectural_info (
      osm_type, osm_id, name, updated_by, updated_at
    )
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run('way', 8008, 'Удаляемый дом', 'admin@example.com');

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(7, 'way', 8008, 'user@example.com', 'Удаляемый дом', 'accepted');

  const deleted = await service.deleteUserEdit(7);
  assert.equal(deleted?.status, 'accepted');
  assert.equal(deleted?.deletedMergedLocal, true);

  const editRow = db.prepare(`
    SELECT 1
    FROM user_edits.building_user_edits
    WHERE id = ?
  `).get(7);
  assert.equal(editRow, undefined);

  const localRow = db.prepare(`
    SELECT 1
    FROM local.architectural_info
    WHERE osm_type = ? AND osm_id = ?
  `).get('way', 8008);
  assert.equal(localRow, undefined);
});

test('deleteUserEdit blocks deleting accepted edit when merged state is shared', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO local.architectural_info (
      osm_type, osm_id, name, updated_by, updated_at
    )
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run('way', 9009, 'Общий дом', 'admin@example.com');

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, status, created_at, updated_at
    )
    VALUES
      (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now')),
      (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    8,
    'way',
    9009,
    'user-1@example.com',
    'Общий дом',
    'accepted',
    9,
    'way',
    9009,
    'user-2@example.com',
    'Общий дом',
    'partially_accepted'
  );

  await assert.rejects(
    () => service.deleteUserEdit(8),
    (error) => error?.code === 'EDIT_DELETE_SHARED_MERGED_STATE'
  );

  const editRow = db.prepare(`
    SELECT 1
    FROM user_edits.building_user_edits
    WHERE id = ?
  `).get(8);
  assert.ok(editRow);

  const localRow = db.prepare(`
    SELECT 1
    FROM local.architectural_info
    WHERE osm_type = ? AND osm_id = ?
  `).get('way', 9009);
  assert.ok(localRow);
});

