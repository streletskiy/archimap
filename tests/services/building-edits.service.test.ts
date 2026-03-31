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
      design TEXT,
      design_ref TEXT,
      design_year INTEGER,
      material TEXT,
      material_concrete TEXT,
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
      sync_status TEXT,
      sync_attempted_at TEXT,
      sync_succeeded_at TEXT,
      sync_cleaned_at TEXT,
      sync_changeset_id INTEGER,
      sync_summary_json TEXT,
      sync_error_text TEXT,
      source_geometry_json TEXT,
      source_tags_json TEXT,
      source_osm_updated_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE osm.building_contours (
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      tags_json TEXT,
      geometry_json TEXT,
      updated_at TEXT
    );

    CREATE TABLE local.architectural_info (
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      name TEXT,
      style TEXT,
      design TEXT,
      design_ref TEXT,
      design_year INTEGER,
      material TEXT,
      material_concrete TEXT,
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

test('buildChangesFromRows labels levels changes with building:levels', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json)
    VALUES (?, ?, ?)
  `).run(
    'way',
    2302,
    JSON.stringify({
      name: 'Дом с этажностью',
      'building:levels': '2'
    })
  );

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, style, levels, year_built, architect, address, archimap_description, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    23,
    'way',
    2302,
    'user@example.com',
    'Дом с этажностью',
    null,
    5,
    null,
    null,
    null,
    null,
    'pending'
  );

  const item = await service.getUserEditDetailsById(23);
  const changes = Array.isArray(item?.changes)
    ? item.changes
    : [];
  const levelsChange = changes.find((change) => String(change.field || '') === 'levels');
  assert.ok(levelsChange);
  assert.equal(levelsChange?.osmTag, 'building:levels');
});

test('buildChangesFromRows labels colour and architect changes with modern tags', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json)
    VALUES (?, ?, ?)
  `).run(
    'way',
    2402,
    JSON.stringify({
      name: 'Дом с цветом и архитектором',
      'building:colour': '#aabbcc',
      architect: 'Old Architect'
    })
  );

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, colour, architect, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    24,
    'way',
    2402,
    'user@example.com',
    'Дом с цветом и архитектором',
    '#112233',
    'New Architect',
    'pending'
  );

  const item = await service.getUserEditDetailsById(24);
  const byField = new Map<string, { osmTag?: string }>(
    (item?.changes || []).map((change) => [String(change.field || ''), change])
  );
  assert.equal(byField.get('colour')?.osmTag, 'building:colour');
  assert.equal(byField.get('architect')?.osmTag, 'architect');
});

test('buildChangesFromRows treats concrete material variants as one selection', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json)
    VALUES (?, ?, ?)
  `).run(
    'way',
    2102,
    JSON.stringify({
      'building:material': 'concrete',
      'building:material:concrete': 'panels'
    })
  );

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, material, material_concrete, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    21,
    'way',
    2102,
    'user@example.com',
    'concrete',
    'panels',
    'pending'
  );

  const items = await service.getUserEditsList({ status: 'pending', limit: 10 });
  assert.equal(items.length, 1);

  const fields = new Set((items[0].changes || []).map((change) => String(change.field || '')));
  assert.equal(fields.has('material'), false);
});

test('getUserEditDetailsById exposes design project changes and values', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json)
    VALUES (?, ?, ?)
  `).run(
    'way',
    2202,
    JSON.stringify({
      name: 'Дом с типовым тегом',
      'design:ref': '1-447С-42'
    })
  );

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, design, design_ref, design_year, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    22,
    'way',
    2202,
    'user@example.com',
    'Дом с типовым тегом',
    'typical',
    '1-447С-43',
    1972,
    'pending'
  );

  const item = await service.getUserEditDetailsById(22);
  assert.ok(item);
  assert.equal(item?.values.design, 'typical');
  assert.equal(item?.values.design_ref, '1-447С-43');
  assert.equal(item?.values.design_year, 1972);
  const fields = new Set((item?.changes || []).map((change) => String(change.field || '')));
  assert.equal(fields.has('design'), true);
  assert.equal(fields.has('design_ref'), true);
  assert.equal(fields.has('design_year'), true);
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
  assert.equal(items[0].hasSourceSnapshot, false);
});

test('getUserEditDetailsById marks overpass-backed edit snapshots separately from deleted contours', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, status, source_geometry_json, source_tags_json, source_osm_updated_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    31,
    'way',
    3101,
    'user@example.com',
    'Overpass building',
    'pending',
    JSON.stringify({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }),
    JSON.stringify({ name: 'Overpass building' }),
    null
  );

  const item = await service.getUserEditDetailsById(31);
  assert.ok(item);
  assert.equal(item?.osmPresent, false);
  assert.equal(item?.hasSourceSnapshot, true);
  assert.equal(item?.sourceOsmUpdatedAt, null);
});

test('accepted edit keeps original change counters visible after merge', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json)
    VALUES (?, ?, ?)
  `).run(
    'way',
    3103,
    JSON.stringify({
      name: 'Исходное имя',
      architect: 'Старый архитектор'
    })
  );

  db.prepare(`
    INSERT INTO local.architectural_info (
      osm_type, osm_id, name, architect, updated_by, updated_at
    )
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run('way', 3103, 'Принятое имя', 'Новый архитектор', 'admin@example.com');

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, architect, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(11, 'way', 3103, 'user@example.com', 'Принятое имя', 'Новый архитектор', 'accepted');

  const items = await service.getUserEditsList({ status: 'accepted', limit: 10 });
  assert.equal(items.length, 1);
  assert.ok(Array.isArray(items[0].changes));
  const fields = new Set(items[0].changes.map((change) => String(change.field || '')));
  assert.equal(fields.has('name'), true);
  assert.equal(fields.has('architect'), true);
  assert.equal(items[0].changes.length, 2);
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

test('withdrawPendingUserEdit removes the current user pending edit', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(60, 'way', 6060, 'user@example.com', 'Черновик', 'pending');

  const withdrawn = await service.withdrawPendingUserEdit(60, 'user@example.com');
  assert.equal(withdrawn?.editId, 60);
  assert.equal(withdrawn?.status, 'pending');
  assert.equal(withdrawn?.deletedMergedLocal, false);

  const row = db.prepare(`
    SELECT 1
    FROM user_edits.building_user_edits
    WHERE id = ?
  `).get(60);
  assert.equal(row, undefined);
});

test('withdrawPendingUserEdit blocks edits from other users and non-pending rows', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, status, created_at, updated_at
    )
    VALUES
      (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now')),
      (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    61,
    'way',
    6061,
    'other@example.com',
    'Чужая правка',
    'pending',
    62,
    'way',
    6062,
    'user@example.com',
    'Уже рассмотрено',
    'rejected'
  );

  await assert.rejects(
    () => service.withdrawPendingUserEdit(61, 'user@example.com'),
    (error) => error?.code === 'EDIT_ACCESS_DENIED'
  );

  await assert.rejects(
    () => service.withdrawPendingUserEdit(62, 'user@example.com'),
    (error) => error?.code === 'EDIT_NOT_PENDING'
  );
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

test('synced, cleaned, and syncing edits are read only in admin moderation actions', async () => {
  const db = createTestDb();
  const service = createBuildingEditsService({ db, normalizeUserEditStatus });

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, name, status, sync_status, created_at, updated_at
    )
    VALUES
      (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now')),
      (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now')),
      (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    10, 'way', 3010, 'user@example.com', 'Synced building', 'accepted', 'synced',
    11, 'way', 3011, 'user@example.com', 'Cleaned building', 'accepted', 'cleaned',
    12, 'way', 3012, 'user@example.com', 'Syncing building', 'accepted', 'syncing'
  );

  const cases = [
    { editId: 10, message: /already been synchronized/i },
    { editId: 11, message: /already been synchronized/i },
    { editId: 12, message: /currently being synchronized/i }
  ];

  for (const { editId, message } of cases) {
    await assert.rejects(
      () => service.reassignUserEdit(editId, { osmType: 'way', osmId: editId + 1 }, { actor: 'admin@example.com' }),
      (error) => {
        assert.match(error.message, message);
        return true;
      }
    );

    await assert.rejects(
      () => service.deleteUserEdit(editId),
      (error) => {
        assert.match(error.message, message);
        return true;
      }
    );
  }
});

