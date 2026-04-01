const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createFeatureInfoSupport } = require('../../src/lib/server/http/feature-info.http');

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
      roof_shape TEXT,
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
    },
    close() {
      sqlite.close();
    }
  };
}

test('feature-info support attaches local info through the repository', async () => {
  const db = createTestDb();
  try {
    db.prepare(`
    INSERT INTO local.architectural_info (
        osm_type, osm_id, name, style, roof_shape, updated_by, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run('way', 101, 'Alpha House', 'constructivism', 'gabled', 'editor@example.test');

    const support = createFeatureInfoSupport({
      db,
      mergePersonalEditsIntoFeatureInfo: async (features, actorKey) => {
        for (const feature of features) {
          feature.properties.personalActor = actorKey;
        }
      }
    });

    const features: Array<LooseRecord> = [
      { id: 'way/101', properties: { existing: true } },
      { id: 'relation/202', properties: {} }
    ];

    const result = await support.attachInfoToFeatures(features, { actorKey: '  Editor@Test.Com ' });
    assert.equal(result, features);
    assert.equal(features[0].properties.archiInfo.name, 'Alpha House');
    assert.equal(features[0].properties.archiInfo.roof_shape, 'gabled');
    assert.equal(features[0].properties.hasExtraInfo, true);
    assert.equal(features[0].properties.personalActor, 'editor@test.com');
    assert.equal(features[1].properties.archiInfo, null);
    assert.equal(features[1].properties.hasExtraInfo, false);
    assert.equal(features[1].properties.personalActor, 'editor@test.com');
  } finally {
    db.close();
  }
});

test('feature-info rowToFeature preserves render heights from contour tags', async () => {
  const db = createTestDb();
  try {
    const support = createFeatureInfoSupport({ db });
    const feature = support.rowToFeature({
      osm_type: 'way',
      osm_id: 303,
      tags_json: JSON.stringify({
        building: 'yes',
        height: '18.5',
        min_height: '5.5'
      }),
      geometry_json: JSON.stringify({
        type: 'Polygon',
        coordinates: [[
          [37.6, 55.75],
          [37.62, 55.75],
          [37.62, 55.77],
          [37.6, 55.77],
          [37.6, 55.75]
        ]]
      }),
      min_lon: 37.6,
      min_lat: 55.75,
      max_lon: 37.62,
      max_lat: 55.77,
      updated_at: '2026-04-01 00:00:00'
    });

    assert.equal(feature.properties.render_height_m, 18.5);
    assert.equal(feature.properties.render_min_height_m, 5.5);
    assert.equal(feature.properties.renderHeightMeters, 18.5);
    assert.equal(feature.properties.renderMinHeightMeters, 5.5);
  } finally {
    db.close();
  }
});
