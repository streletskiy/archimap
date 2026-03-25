const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createBuildingsRepository } = require('../../src/lib/server/services/buildings.repository');

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    ATTACH DATABASE ':memory:' AS osm;
    ATTACH DATABASE ':memory:' AS local;
    ATTACH DATABASE ':memory:' AS user_edits;

    CREATE TABLE osm.building_contours (
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      tags_json TEXT,
      geometry_json TEXT NOT NULL,
      min_lon REAL NOT NULL,
      min_lat REAL NOT NULL,
      max_lon REAL NOT NULL,
      max_lat REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (osm_type, osm_id)
    );

    CREATE TABLE data_sync_regions (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL
    );

    CREATE TABLE data_region_memberships (
      region_id INTEGER NOT NULL,
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL
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

    CREATE TABLE user_edits.building_user_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      source_osm_version TEXT,
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
      edited_fields_json TEXT,
      source_tags_json TEXT,
      source_osm_updated_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_comment TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      merged_by TEXT,
      merged_at TEXT,
      merged_fields_json TEXT,
      sync_status TEXT NOT NULL DEFAULT 'unsynced',
      sync_attempted_at TEXT,
      sync_succeeded_at TEXT,
      sync_cleaned_at TEXT,
      sync_changeset_id INTEGER,
      sync_summary_json TEXT,
      sync_error_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    },
    close() {
      sqlite.close();
    }
  };
}

test('buildings repository reads contours, region slugs, and local info rows', async () => {
  const db = createTestDb();
  try {
    db.prepare(`
      INSERT INTO osm.building_contours (
        osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'way',
      101,
      '{"name":"Alpha"}',
      '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}',
      0,
      0,
      1,
      1
    );

    db.prepare('INSERT INTO data_sync_regions (id, slug) VALUES (?, ?)').run(1, 'a');
    db.prepare('INSERT INTO data_sync_regions (id, slug) VALUES (?, ?)').run(2, 'longer-slug');
    db.prepare('INSERT INTO data_sync_regions (id, slug) VALUES (?, ?)').run(3, 'bb');
    db.prepare('INSERT INTO data_region_memberships (region_id, osm_type, osm_id) VALUES (?, ?, ?)').run(1, 'way', 101);
    db.prepare('INSERT INTO data_region_memberships (region_id, osm_type, osm_id) VALUES (?, ?, ?)').run(2, 'way', 101);
    db.prepare('INSERT INTO data_region_memberships (region_id, osm_type, osm_id) VALUES (?, ?, ?)').run(3, 'way', 101);

    db.prepare(`
      INSERT INTO local.architectural_info (
        osm_type, osm_id, name, style, updated_by, updated_at
      )
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run('way', 101, 'Alpha House', 'constructivism', 'editor@example.test');
    db.prepare(`
      INSERT INTO local.architectural_info (
        osm_type, osm_id, name, style, updated_by, updated_at
      )
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run('relation', 202, 'Beta House', 'modernism', 'editor@example.test');

    const repository = createBuildingsRepository({ db });

    const building = await repository.getBuildingById('way', 101);
    assert.equal(building?.osm_type, 'way');
    assert.equal(building?.osm_id, 101);
    assert.equal(building?.geometry_json.includes('"Polygon"'), true);

    const regionSlugs = (await repository.getBuildingRegionSlugsById('way', 101))
      .map((row) => String(row?.slug || ''));
    assert.deepEqual(regionSlugs, ['longer-slug', 'bb', 'a']);

    const localRows = await repository.getLocalArchitecturalInfoRowsByKeys([
      'way/101',
      { osmType: 'relation', osmId: 202 },
      'invalid'
    ]);
    assert.equal(localRows.length, 2);
    assert.deepEqual(
      localRows.map((row) => `${row.osm_type}/${row.osm_id}`).sort(),
      ['relation/202', 'way/101']
    );
  } finally {
    db.close();
  }
});

test('buildings repository inserts and updates pending edits', async () => {
  const db = createTestDb();
  try {
    const repository = createBuildingsRepository({ db });

    const editId = await repository.insertPendingUserEdit({
      osm_type: 'way',
      osm_id: 101,
      created_by: 'editor@example.test',
      source_osm_version: null,
      name: 'Draft House',
      style: 'constructivism',
      design: 'typical',
      design_ref: '1-447',
      design_year: 1972,
      material: 'concrete',
      material_concrete: 'blocks',
      colour: '#ffffff',
      levels: 5,
      year_built: 1988,
      architect: 'Alice',
      address: 'Main street, 1',
      archimap_description: 'Initial note',
      edited_fields_json: '["name"]',
      source_tags_json: '{"name":"Alpha"}',
      source_osm_updated_at: '2026-01-01T00:00:00Z'
    });

    assert.equal(Number.isInteger(editId) && editId > 0, true);

    db.prepare(`
      UPDATE user_edits.building_user_edits
      SET
        admin_comment = 'needs review',
        reviewed_by = 'moderator@example.test',
        reviewed_at = '2026-01-02T00:00:00Z',
        merged_by = 'moderator@example.test',
        merged_at = '2026-01-02T00:00:00Z',
        merged_fields_json = '["name"]',
        sync_status = 'synced',
        sync_attempted_at = '2026-01-03T00:00:00Z',
        sync_succeeded_at = '2026-01-03T00:00:00Z',
        sync_cleaned_at = '2026-01-03T00:00:00Z',
        sync_changeset_id = 123,
        sync_summary_json = '{"ok":true}',
        sync_error_text = 'old error'
      WHERE id = ?
    `).run(editId);

    await repository.updatePendingUserEditById(editId, {
      source_osm_version: 'v2',
      name: 'Updated House',
      style: 'neo-classical',
      design: null,
      design_ref: null,
      design_year: null,
      material: 'brick',
      material_concrete: null,
      colour: '#000000',
      levels: 6,
      year_built: 1989,
      architect: 'Bob',
      address: 'Updated street, 2',
      archimap_description: 'Updated note',
      edited_fields_json: '["style"]',
      source_tags_json: '{"name":"Alpha","style":"neo-classical"}',
      source_osm_updated_at: '2026-01-04T00:00:00Z'
    });

    const row = db.prepare(`
      SELECT *
      FROM user_edits.building_user_edits
      WHERE id = ?
    `).get(editId);

    assert.equal(row?.name, 'Updated House');
    assert.equal(row?.style, 'neo-classical');
    assert.equal(row?.material, 'brick');
    assert.equal(row?.status, 'pending');
    assert.equal(row?.sync_status, 'unsynced');
    assert.equal(row?.admin_comment, null);
    assert.equal(row?.reviewed_by, null);
    assert.equal(row?.reviewed_at, null);
    assert.equal(row?.merged_by, null);
    assert.equal(row?.merged_at, null);
    assert.equal(row?.merged_fields_json, null);
    assert.equal(row?.sync_attempted_at, null);
    assert.equal(row?.sync_succeeded_at, null);
    assert.equal(row?.sync_cleaned_at, null);
    assert.equal(row?.sync_changeset_id, null);
    assert.equal(row?.sync_summary_json, null);
    assert.equal(row?.sync_error_text, null);
    assert.equal(row?.source_osm_version, 'v2');
  } finally {
    db.close();
  }
});
