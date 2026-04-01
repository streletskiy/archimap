const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createOsmSyncService } = require('../../src/lib/server/services/osm-sync.service');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    ATTACH ':memory:' AS user_edits;
    ATTACH ':memory:' AS osm;
    ATTACH ':memory:' AS local;

    CREATE TABLE app_general_settings (
      id INTEGER PRIMARY KEY,
      app_display_name TEXT,
      app_base_url TEXT
    );

    CREATE TABLE app_osm_settings (
      id INTEGER PRIMARY KEY,
      provider_name TEXT,
      auth_base_url TEXT,
      api_base_url TEXT,
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
      updated_at TEXT
    );

    CREATE TABLE app_osm_oauth_states (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE user_edits.building_user_edits (
      id INTEGER PRIMARY KEY,
      osm_type TEXT NOT NULL,
      osm_id INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      status TEXT NOT NULL,
      edited_fields_json TEXT,
      source_osm_version INTEGER,
      source_tags_json TEXT,
      source_osm_updated_at TEXT,
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
      sync_status TEXT,
      sync_attempted_at TEXT,
      sync_succeeded_at TEXT,
      sync_cleaned_at TEXT,
      sync_changeset_id INTEGER,
      sync_summary_json TEXT,
      sync_error_text TEXT,
      updated_at TEXT,
      created_at TEXT
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
  return db;
}

function createFetchResponse(body, status = 200) {
  const textBody = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => textBody
  };
}

function installFetchMock(handlers) {
  const previous = global.fetch;
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    for (const handler of handlers) {
      const result = await handler(url, init);
      if (result) return result;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return () => {
    global.fetch = previous;
  };
}

async function withTimeout(promise, timeoutMs = 1000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test('saveSettings encrypts the client secret and OAuth callback stores connected token state', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');

  const restore = installFetchMock([
    (url, _init) => {
      if (url.endsWith('/oauth2/token')) {
        return createFetchResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          scope: 'write_api write_changeset_comments'
        });
      }
      if (url.endsWith('/api/0.6/user/details')) {
        return createFetchResponse('<osm><user display_name="Test User"/></osm>');
      }
      return null;
    }
  ]);

  const service = createOsmSyncService({
    db,
    settingsSecret: 'test-secret'
  });

  await service.saveSettings({
    providerName: 'OpenStreetMap',
    authBaseUrl: 'https://www.openstreetmap.org',
    apiBaseUrl: 'https://api.openstreetmap.org',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/admin/app-settings/osm/oauth/callback'
  }, 'admin@example.com');

  const row = db.prepare(`
    SELECT client_secret_enc
    FROM app_osm_settings
    WHERE id = 1
  `).get();
  assert.ok(String(row.client_secret_enc || '').includes('.'));
  assert.notEqual(String(row.client_secret_enc || ''), 'client-secret');

  const oauth = await service.startOAuth('admin@example.com');
  const result = await service.handleOauthCallback({
    code: 'auth-code',
    state: oauth.state
  });

  restore();

  assert.equal(result.osm.connectedUser, 'Test User');
  assert.equal(result.osm.hasAccessToken, true);
  assert.equal(result.osm.hasRefreshToken, true);
});

test('startOAuth rejects when the OSM client secret is missing', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');
  const service = createOsmSyncService({
    db,
    settingsSecret: 'test-secret'
  });

  await service.saveSettings({
    providerName: 'OpenStreetMap',
    authBaseUrl: 'https://www.openstreetmap.org',
    apiBaseUrl: 'https://api.openstreetmap.org',
    clientId: 'client-id',
    redirectUri: 'https://example.com/api/admin/app-settings/osm/oauth/callback'
  }, 'admin@example.com');

  await assert.rejects(
    () => service.startOAuth('admin@example.com'),
    (error) => {
      assert.equal(error.code, 'OSM_SYNC_CLIENT_SECRET_MISSING');
      assert.equal(error.status, 503);
      return true;
    }
  );
});

test('saveSettings only maps the OSM master auth host to the master API host', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');
  const service = createOsmSyncService({
    db,
    settingsSecret: 'test-secret'
  });

  await service.saveSettings({
    providerName: 'OpenStreetMap',
    authBaseUrl: 'https://master.apis.dev.openstreetmap.org',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/admin/app-settings/osm/oauth/callback'
  }, 'admin@example.com');

  let row = db.prepare(`
    SELECT api_base_url
    FROM app_osm_settings
    WHERE id = 1
  `).get();
  assert.equal(row.api_base_url, 'https://master.apis.dev.openstreetmap.org');

  const fallbackDb = createTestDb();
  fallbackDb.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');
  const fallbackService = createOsmSyncService({
    db: fallbackDb,
    settingsSecret: 'test-secret'
  });

  await fallbackService.saveSettings({
    providerName: 'OpenStreetMap',
    authBaseUrl: 'https://master.apis.dev.openstreetmap.org.evil',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/admin/app-settings/osm/oauth/callback'
  }, 'admin@example.com');

  row = fallbackDb.prepare(`
    SELECT api_base_url
    FROM app_osm_settings
    WHERE id = 1
  `).get();
  assert.equal(row.api_base_url, 'https://api.openstreetmap.org');
});

test('listSyncCandidates groups accepted edits by building and exposes sync state', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');
  const service = createOsmSyncService({ db, settingsSecret: 'test-secret' });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 101, JSON.stringify({ name: 'Old Name' }), '2026-01-01T00:00:00Z');
  db.prepare(`
    INSERT INTO local.architectural_info (
      osm_type, osm_id, name, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run('way', 101, 'New Name', '2026-01-02T00:00:00Z');

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, name, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'way', 101, 'admin@example.com', 'accepted', JSON.stringify(['name']), JSON.stringify({ name: 'Old Name' }), '2026-01-01T00:00:00Z', 'New Name', 'unsynced', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, name, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 'way', 101, 'admin@example.com', 'partially_accepted', JSON.stringify(['name']), JSON.stringify({ name: 'Old Name' }), '2026-01-01T00:00:00Z', 'New Name', 'synced', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, name, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(3, 'relation', 202, 'admin@example.com', 'accepted', JSON.stringify(['name']), JSON.stringify({ name: 'Rel Old' }), '2026-01-01T00:00:00Z', 'Rel New', 'failed', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');

  const candidates = await service.listSyncCandidates();

  assert.equal(candidates.total, 2);
  assert.equal(candidates.page, 1);
  assert.equal(candidates.pageSize, 200);
  assert.equal(candidates.pageCount, 1);
  assert.equal(candidates.items.length, 2);
  const first = candidates.items.find((item) => item.osmId === 101);
  assert.equal(first.totalEdits, 2);
  assert.equal(first.syncStatus, 'synced');
  assert.equal(first.syncReadOnly, true);
  assert.equal(first.canSync, false);

  const second = candidates.items.find((item) => item.osmId === 202);
  assert.equal(second.syncStatus, 'failed');
  assert.equal(second.syncReadOnly, false);
  assert.equal(second.canSync, true);

  const activeCandidates = await service.listSyncCandidates({ sync: 'active', limit: 1, page: 1 });
  assert.equal(activeCandidates.total, 1);
  assert.equal(activeCandidates.pageCount, 1);
  assert.equal(activeCandidates.items[0].osmId, 202);

  const archivedCandidates = await service.listSyncCandidates({ sync: 'archived', limit: 1, page: 1 });
  assert.equal(archivedCandidates.total, 1);
  assert.equal(archivedCandidates.pageCount, 1);
  assert.equal(archivedCandidates.items[0].osmId, 101);
});

test('listSyncCandidates derives displayAddress from contour address tags', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');
  const service = createOsmSyncService({ db, settingsSecret: 'test-secret' });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(
    'way',
    150,
    JSON.stringify({
      'addr:street': 'улица Нестерова',
      'addr:housenumber': '4А'
    }),
    '2026-01-01T00:00:00Z'
  );
  db.prepare(`
    INSERT INTO local.architectural_info (
      osm_type, osm_id, updated_at
    ) VALUES (?, ?, ?)
  `).run('way', 150, '2026-01-02T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, name, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(150, 'way', 150, 'admin@example.com', 'accepted', JSON.stringify(['name']), JSON.stringify({ name: 'Old Name' }), '2026-01-01T00:00:00Z', 'New Name', 'unsynced', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');

  const candidates = await service.listSyncCandidates();
  const candidate = candidates.items.find((item) => item.osmId === 150);

  assert.ok(candidate);
  assert.equal(candidate.displayAddress, 'улица Нестерова, 4А');
});

test('listSyncCandidates reactivates a building when a newer accepted edit is still unsynced', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');
  const service = createOsmSyncService({ db, settingsSecret: 'test-secret' });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 303, JSON.stringify({ name: 'Old Name' }), '2026-01-01T00:00:00Z');
  db.prepare(`
    INSERT INTO local.architectural_info (
      osm_type, osm_id, name, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run('way', 303, 'New Name', '2026-01-04T00:00:00Z');

  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, name, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    4,
    'way',
    303,
    'admin@example.com',
    'accepted',
    JSON.stringify(['name']),
    JSON.stringify({ name: 'Old Name' }),
    '2026-01-01T00:00:00Z',
    'New Name',
    'synced',
    '2026-01-02T00:00:00Z',
    '2026-01-02T00:00:00Z'
  );
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, name, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    5,
    'way',
    303,
    'admin@example.com',
    'accepted',
    JSON.stringify(['name']),
    JSON.stringify({ name: 'Old Name' }),
    '2026-01-01T00:00:00Z',
    'New Name',
    'unsynced',
    '2026-01-04T00:00:00Z',
    '2026-01-04T00:00:00Z'
  );

  const candidates = await service.listSyncCandidates();
  const candidate = candidates.items.find((item) => item.osmId === 303);

  assert.ok(candidate);
  assert.equal(candidate.totalEdits, 2);
  assert.equal(candidate.latestEditId, 5);
  assert.equal(candidate.syncStatus, 'unsynced');
  assert.equal(candidate.syncReadOnly, false);
  assert.equal(candidate.canSync, true);
});

test('getSyncCandidate keeps untouched contour tags in the desired map when live OSM is unavailable', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');
  const service = createOsmSyncService({ db, settingsSecret: 'test-secret' });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(
    'way',
    404,
    JSON.stringify({
      building: 'yes',
      source: 'survey',
      name: 'Old Name'
    }),
    '2026-01-01T00:00:00Z'
  );
  db.prepare(`
    INSERT INTO local.architectural_info (
      osm_type, osm_id, name, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run('way', 404, 'New Name', '2026-01-02T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, name, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    404,
    'way',
    404,
    'admin@example.com',
    'accepted',
    JSON.stringify(['name']),
    JSON.stringify({
      building: 'yes',
      source: 'survey',
      name: 'Old Name'
    }),
    '2026-01-01T00:00:00Z',
    'New Name',
    'unsynced',
    '2026-01-02T00:00:00Z',
    '2026-01-02T00:00:00Z'
  );

  const candidate = await service.getSyncCandidate('way', 404);

  assert.ok(candidate);
  assert.equal(candidate.currentContourTags.building, 'yes');
  assert.equal(candidate.desiredTags.building, 'yes');
  assert.equal(candidate.desiredTags.source, 'survey');
  assert.equal(candidate.desiredTags.name, 'New Name');
});

test('listSyncCandidates avoids sqlite-only datetime ordering so postgres can list candidates', async () => {
  const rows = [
    {
      id: 4,
      osm_type: 'way',
      osm_id: 80061889,
      created_by: 'nortondeicide@gmail.com',
      status: 'accepted',
      edited_fields_json: JSON.stringify(['name']),
      source_osm_version: null,
      sync_status: 'unsynced',
      sync_attempted_at: null,
      sync_succeeded_at: null,
      sync_cleaned_at: null,
      sync_changeset_id: null,
      sync_summary_json: null,
      sync_error_text: null,
      source_tags_json: JSON.stringify({ name: 'Old Name' }),
      source_osm_updated_at: '2026-03-20T09:00:00Z',
      updated_at: '2026-03-20T09:05:26.615734Z',
      created_at: '2026-03-20T09:05:26.615734Z',
      local_name: 'New Name',
      local_style: null,
      local_material: null,
      local_material_concrete: null,
      local_colour: null,
      local_levels: null,
      local_year_built: null,
      local_architect: null,
      local_address: null,
      local_description: null,
      local_archimap_description: null,
      local_updated_at: '2026-03-20T09:05:26.615734Z',
      contour_tags_json: JSON.stringify({ name: 'Old Name' }),
      contour_updated_at: '2026-03-20T09:00:00Z'
    }
  ];
  const preparedSql = [];
  const db = {
    prepare(sql) {
      const text = String(sql || '');
      preparedSql.push(text);
      if (text.includes('ORDER BY datetime(ue.updated_at)')) {
        throw new Error('sqlite-only ordering should not be used in postgres mode');
      }
      return {
        all: () => {
          if (text.includes('FROM user_edits.building_user_edits ue')) {
            return rows;
          }
          return [];
        },
        get: () => (text.includes('COUNT(*) AS total') ? { total: rows.length } : null),
        run: () => ({ changes: 0, lastInsertRowid: 0 })
      };
    }
  };

  const service = createOsmSyncService({ db, settingsSecret: 'test-secret' });
  const candidates = await service.listSyncCandidates();

  assert.equal(candidates.total, 1);
  assert.equal(candidates.items.length, 1);
  assert.equal(candidates.items[0].osmId, 80061889);
  assert.ok(preparedSql.some((sql) => sql.includes('ORDER BY page_groups.latest_updated_at DESC, ranked.updated_at DESC, ranked.id DESC')));
  assert.ok(!preparedSql.some((sql) => sql.includes('ORDER BY datetime(ue.updated_at)')));
});

test('syncCandidateToOsm publishes diff and marks rows as synced', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');

  const changesetBodies = [];
  const restore = installFetchMock([
    (url, init) => {
      if (url.endsWith('/oauth2/token')) {
        return createFetchResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          scope: 'write_api write_changeset_comments'
        });
      }
      if (url.endsWith('/api/0.6/user/details')) {
        return createFetchResponse('<osm><user display_name="Test User"/></osm>');
      }
      if (url.endsWith('/api/0.6/way/101') && (!init.method || init.method === 'GET')) {
        return createFetchResponse('<osm><way id="101" version="3" visible="true"><tag k="name" v="Old Name"/></way></osm>');
      }
      if (url.endsWith('/api/0.6/changeset/create') && init.method === 'PUT') {
        changesetBodies.push(String(init.body || ''));
        return createFetchResponse('123');
      }
      if (url.endsWith('/api/0.6/way/101') && init.method === 'PUT') {
        return createFetchResponse('');
      }
      if (url.endsWith('/api/0.6/changeset/123/close') && init.method === 'PUT') {
        return createFetchResponse('');
      }
      return null;
    }
  ]);

  const service = createOsmSyncService({ db, settingsSecret: 'test-secret' });
  await service.saveSettings({
    providerName: 'OpenStreetMap',
    authBaseUrl: 'https://www.openstreetmap.org',
    apiBaseUrl: 'https://api.openstreetmap.org',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/admin/app-settings/osm/oauth/callback'
  }, 'admin@example.com');
  const oauth = await service.startOAuth('admin@example.com');
  await service.handleOauthCallback({
    code: 'auth-code',
    state: oauth.state
  });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 101, JSON.stringify({ name: 'Old Name' }), '2026-01-01T00:00:00Z');
  db.prepare(`
    INSERT INTO local.architectural_info (osm_type, osm_id, name, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 101, 'New Name', '2026-01-02T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, name, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'way', 101, 'admin@example.com', 'accepted', JSON.stringify(['name']), JSON.stringify({ name: 'Old Name' }), '2026-01-01T00:00:00Z', 'New Name', 'unsynced', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');

  const result = await service.syncCandidateToOsm('way', 101, 'admin@example.com');
  restore();

  assert.equal(result.ok, true);
  assert.equal(result.changesetId, 123);
  assert.equal(changesetBodies.length, 1);
  assert.match(changesetBodies[0], /Update architectural info:/);

  const row = db.prepare(`
    SELECT sync_status, sync_changeset_id, sync_summary_json
    FROM user_edits.building_user_edits
    WHERE id = 1
  `).get();
  assert.equal(row.sync_status, 'synced');
  assert.equal(Number(row.sync_changeset_id), 123);
  assert.match(String(row.sync_summary_json || ''), /123/);
});

test('syncCandidateToOsm writes style only to building:architecture and removes legacy tags', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');

  const putBodies = [];
  const restore = installFetchMock([
    (url, init) => {
      if (url.endsWith('/oauth2/token')) {
        return createFetchResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          scope: 'write_api write_changeset_comments'
        });
      }
      if (url.endsWith('/api/0.6/user/details')) {
        return createFetchResponse('<osm><user display_name="Test User"/></osm>');
      }
      if (url.endsWith('/api/0.6/way/102') && (!init.method || init.method === 'GET')) {
        return createFetchResponse('<osm><way id="102" version="3" visible="true"><tag k="architecture" v="Old Style"/><tag k="style" v="Old Style"/></way></osm>');
      }
      if (url.endsWith('/api/0.6/changeset/create') && init.method === 'PUT') {
        return createFetchResponse('124');
      }
      if (url.endsWith('/api/0.6/way/102') && init.method === 'PUT') {
        putBodies.push(String(init.body || ''));
        return createFetchResponse('');
      }
      if (url.endsWith('/api/0.6/changeset/124/close') && init.method === 'PUT') {
        return createFetchResponse('');
      }
      return null;
    }
  ]);

  const service = createOsmSyncService({ db, settingsSecret: 'test-secret' });
  await service.saveSettings({
    providerName: 'OpenStreetMap',
    authBaseUrl: 'https://www.openstreetmap.org',
    apiBaseUrl: 'https://api.openstreetmap.org',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/admin/app-settings/osm/oauth/callback'
  }, 'admin@example.com');
  const oauth = await service.startOAuth('admin@example.com');
  await service.handleOauthCallback({
    code: 'auth-code',
    state: oauth.state
  });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 102, JSON.stringify({ architecture: 'Old Style', style: 'Old Style' }), '2026-01-01T00:00:00Z');
  db.prepare(`
    INSERT INTO local.architectural_info (osm_type, osm_id, style, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 102, 'New Style', '2026-01-02T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, style, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(4, 'way', 102, 'admin@example.com', 'accepted', JSON.stringify(['style']), JSON.stringify({ architecture: 'Old Style', style: 'Old Style' }), '2026-01-01T00:00:00Z', 'New Style', 'unsynced', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');

  const result = await service.syncCandidateToOsm('way', 102, 'admin@example.com');
  restore();

  assert.equal(result.ok, true);
  assert.equal(putBodies.length, 1);
  assert.match(putBodies[0], /^<osm version="0\.6">/);
  assert.match(putBodies[0], /<way id="102" version="3" visible="true" changeset="124">/);
  assert.match(putBodies[0], /<tag k="building:architecture" v="New Style"\/>/);
  assert.equal(putBodies[0].includes('k="architecture"'), false);
  assert.equal(putBodies[0].includes('k="style"'), false);
});

test('syncCandidateToOsm writes roof shape only to roof:shape and removes legacy aliases', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');

  const putBodies = [];
  const restore = installFetchMock([
    (url, init) => {
      if (url.endsWith('/oauth2/token')) {
        return createFetchResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          scope: 'write_api write_changeset_comments'
        });
      }
      if (url.endsWith('/api/0.6/user/details')) {
        return createFetchResponse('<osm><user display_name="Test User"/></osm>');
      }
      if (url.endsWith('/api/0.6/way/105') && (!init.method || init.method === 'GET')) {
        return createFetchResponse('<osm><way id="105" version="2" visible="true"><tag k="roof:shape" v="flat"/><tag k="roof_shape" v="flat"/><tag k="building:roof:shape" v="flat"/></way></osm>');
      }
      if (url.endsWith('/api/0.6/changeset/create') && init.method === 'PUT') {
        return createFetchResponse('128');
      }
      if (url.endsWith('/api/0.6/way/105') && init.method === 'PUT') {
        putBodies.push(String(init.body || ''));
        return createFetchResponse('');
      }
      if (url.endsWith('/api/0.6/changeset/128/close') && init.method === 'PUT') {
        return createFetchResponse('');
      }
      return null;
    }
  ]);

  const service = createOsmSyncService({ db, settingsSecret: 'test-secret' });
  await service.saveSettings({
    providerName: 'OpenStreetMap',
    authBaseUrl: 'https://www.openstreetmap.org',
    apiBaseUrl: 'https://api.openstreetmap.org',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/admin/app-settings/osm/oauth/callback'
  }, 'admin@example.com');
  const oauth = await service.startOAuth('admin@example.com');
  await service.handleOauthCallback({
    code: 'auth-code',
    state: oauth.state
  });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 105, JSON.stringify({ 'roof:shape': 'flat', roof_shape: 'flat', 'building:roof:shape': 'flat' }), '2026-01-01T00:00:00Z');
  db.prepare(`
    INSERT INTO local.architectural_info (osm_type, osm_id, roof_shape, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 105, 'gabled', '2026-01-02T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, roof_shape, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(15, 'way', 105, 'admin@example.com', 'accepted', JSON.stringify(['roof_shape']), JSON.stringify({ 'roof:shape': 'flat', roof_shape: 'flat' }), '2026-01-01T00:00:00Z', 'gabled', 'unsynced', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');

  const result = await service.syncCandidateToOsm('way', 105, 'admin@example.com');
  restore();

  assert.equal(result.ok, true);
  assert.equal(putBodies.length, 1);
  assert.match(putBodies[0], /<tag k="roof:shape" v="gabled"\/>/);
  assert.equal(putBodies[0].includes('k="roof_shape"'), false);
  assert.equal(putBodies[0].includes('k="building:roof:shape"'), false);
});

test('syncCandidateToOsm writes colour and architect only to modern tags and removes legacy aliases', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');

  const putBodies = [];
  const restore = installFetchMock([
    (url, init) => {
      if (url.endsWith('/oauth2/token')) {
        return createFetchResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          scope: 'write_api write_changeset_comments'
        });
      }
      if (url.endsWith('/api/0.6/user/details')) {
        return createFetchResponse('<osm><user display_name="Test User"/></osm>');
      }
      if (url.endsWith('/api/0.6/way/104') && (!init.method || init.method === 'GET')) {
        return createFetchResponse('<osm><way id="104" version="6" visible="true"><tag k="colour" v="#778899"/><tag k="architect_name" v="Old Architect"/></way></osm>');
      }
      if (url.endsWith('/api/0.6/changeset/create') && init.method === 'PUT') {
        return createFetchResponse('127');
      }
      if (url.endsWith('/api/0.6/way/104') && init.method === 'PUT') {
        putBodies.push(String(init.body || ''));
        return createFetchResponse('');
      }
      if (url.endsWith('/api/0.6/changeset/127/close') && init.method === 'PUT') {
        return createFetchResponse('');
      }
      return null;
    }
  ]);

  const service = createOsmSyncService({ db, settingsSecret: 'test-secret' });
  await service.saveSettings({
    providerName: 'OpenStreetMap',
    authBaseUrl: 'https://www.openstreetmap.org',
    apiBaseUrl: 'https://api.openstreetmap.org',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/admin/app-settings/osm/oauth/callback'
  }, 'admin@example.com');
  const oauth = await service.startOAuth('admin@example.com');
  await service.handleOauthCallback({
    code: 'auth-code',
    state: oauth.state
  });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(
    'way',
    104,
    JSON.stringify({ colour: '#778899', architect_name: 'Old Architect' }),
    '2026-01-01T00:00:00Z'
  );
  db.prepare(`
    INSERT INTO local.architectural_info (osm_type, osm_id, colour, architect, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('way', 104, '#112233', 'New Architect', '2026-01-02T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, colour, architect, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    14,
    'way',
    104,
    'admin@example.com',
    'accepted',
    JSON.stringify(['colour', 'architect']),
    JSON.stringify({ colour: '#778899', architect_name: 'Old Architect' }),
    '2026-01-01T00:00:00Z',
    '#112233',
    'New Architect',
    'unsynced',
    '2026-01-02T00:00:00Z',
    '2026-01-02T00:00:00Z'
  );

  const result = await service.syncCandidateToOsm('way', 104, 'admin@example.com');
  restore();

  assert.equal(result.ok, true);
  assert.equal(putBodies.length, 1);
  assert.match(putBodies[0], /<tag k="building:colour" v="#112233"\/>/);
  assert.match(putBodies[0], /<tag k="architect" v="New Architect"\/>/);
  assert.equal(/<tag k="colour" v="/.test(putBodies[0]), false);
  assert.equal(/<tag k="architect_name" v="/.test(putBodies[0]), false);
});

test('syncCandidateToOsm writes design project tags into OSM XML', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');

  const putBodies = [];
  const restore = installFetchMock([
    (url, init) => {
      if (url.endsWith('/oauth2/token')) {
        return createFetchResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          scope: 'write_api write_changeset_comments'
        });
      }
      if (url.endsWith('/api/0.6/user/details')) {
        return createFetchResponse('<osm><user display_name="Test User"/></osm>');
      }
      if (url.endsWith('/api/0.6/way/103') && (!init.method || init.method === 'GET')) {
        return createFetchResponse('<osm><way id="103" version="2" visible="true"><tag k="name" v="Old Design"/></way></osm>');
      }
      if (url.endsWith('/api/0.6/changeset/create') && init.method === 'PUT') {
        return createFetchResponse('126');
      }
      if (url.endsWith('/api/0.6/way/103') && init.method === 'PUT') {
        putBodies.push(String(init.body || ''));
        return createFetchResponse('');
      }
      if (url.endsWith('/api/0.6/changeset/126/close') && init.method === 'PUT') {
        return createFetchResponse('');
      }
      return null;
    }
  ]);

  const service = createOsmSyncService({ db, settingsSecret: 'test-secret' });
  await service.saveSettings({
    providerName: 'OpenStreetMap',
    authBaseUrl: 'https://www.openstreetmap.org',
    apiBaseUrl: 'https://api.openstreetmap.org',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/admin/app-settings/osm/oauth/callback'
  }, 'admin@example.com');
  const oauth = await service.startOAuth('admin@example.com');
  await service.handleOauthCallback({
    code: 'auth-code',
    state: oauth.state
  });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 103, JSON.stringify({ name: 'Old Design' }), '2026-01-01T00:00:00Z');
  db.prepare(`
    INSERT INTO local.architectural_info (osm_type, osm_id, design, design_ref, design_year, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('way', 103, 'typical', '1-447С-43', 1972, '2026-01-02T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, design, design_ref, design_year, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(13, 'way', 103, 'admin@example.com', 'accepted', JSON.stringify(['design', 'design_ref', 'design_year']), JSON.stringify({ name: 'Old Design' }), '2026-01-01T00:00:00Z', 'typical', '1-447С-43', 1972, 'unsynced', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');

  const result = await service.syncCandidateToOsm('way', 103, 'admin@example.com');
  restore();

  assert.equal(result.ok, true);
  assert.equal(putBodies.length, 1);
  assert.match(putBodies[0], /<tag k="design" v="typical"\/>/);
  assert.match(putBodies[0], /<tag k="design:ref" v="1-447С-43"\/>/);
  assert.match(putBodies[0], /<tag k="design:year" v="1972"\/>/);
});

test('syncCandidatesToOsm publishes multiple buildings in one changeset', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');

  const changesetBodies = [];
  const putBodies = [];
  let refreshCalls = 0;
  let searchRefreshCalls = 0;
  const restore = installFetchMock([
    (url, init) => {
      if (url.endsWith('/oauth2/token')) {
        return createFetchResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          scope: 'write_api write_changeset_comments'
        });
      }
      if (url.endsWith('/api/0.6/user/details')) {
        return createFetchResponse('<osm><user display_name="Test User"/></osm>');
      }
      if (url.endsWith('/api/0.6/way/201') && (!init.method || init.method === 'GET')) {
        return createFetchResponse('<osm><way id="201" version="4" visible="true"><tag k="name" v="Old One"/></way></osm>');
      }
      if (url.endsWith('/api/0.6/way/202') && (!init.method || init.method === 'GET')) {
        return createFetchResponse('<osm><way id="202" version="7" visible="true"><tag k="name" v="Old Two"/></way></osm>');
      }
      if (url.endsWith('/api/0.6/changeset/create') && init.method === 'PUT') {
        changesetBodies.push(String(init.body || ''));
        return createFetchResponse('125');
      }
      if ((url.endsWith('/api/0.6/way/201') || url.endsWith('/api/0.6/way/202')) && init.method === 'PUT') {
        putBodies.push(String(init.body || ''));
        return createFetchResponse('');
      }
      if (url.endsWith('/api/0.6/changeset/125/close') && init.method === 'PUT') {
        return createFetchResponse('');
      }
      return null;
    }
  ]);

  const enqueueSearchIndexRefresh = () => {
    searchRefreshCalls += 1;
  };
  const service = createOsmSyncService({
    db,
    settingsSecret: 'test-secret',
    enqueueSearchIndexRefresh
  });
  await service.saveSettings({
    providerName: 'OpenStreetMap',
    authBaseUrl: 'https://www.openstreetmap.org',
    apiBaseUrl: 'https://api.openstreetmap.org',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/admin/app-settings/osm/oauth/callback'
  }, 'admin@example.com');
  const oauth = await service.startOAuth('admin@example.com');
  await service.handleOauthCallback({
    code: 'auth-code',
    state: oauth.state
  });

  db.prepare(`INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at) VALUES (?, ?, ?, ?)`)
    .run('way', 201, JSON.stringify({ name: 'Old One' }), '2026-01-01T00:00:00Z');
  db.prepare(`INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at) VALUES (?, ?, ?, ?)`)
    .run('way', 202, JSON.stringify({ name: 'Old Two' }), '2026-01-01T00:00:00Z');
  db.prepare(`INSERT INTO local.architectural_info (osm_type, osm_id, name, updated_at) VALUES (?, ?, ?, ?)`)
    .run('way', 201, 'New One', '2026-01-02T00:00:00Z');
  db.prepare(`INSERT INTO local.architectural_info (osm_type, osm_id, name, updated_at) VALUES (?, ?, ?, ?)`)
    .run('way', 202, 'New Two', '2026-01-02T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, name, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(11, 'way', 201, 'admin@example.com', 'accepted', JSON.stringify(['name']), JSON.stringify({ name: 'Old One' }), '2026-01-01T00:00:00Z', 'New One', 'unsynced', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, name, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(12, 'way', 202, 'admin@example.com', 'accepted', JSON.stringify(['name']), JSON.stringify({ name: 'Old Two' }), '2026-01-01T00:00:00Z', 'New Two', 'unsynced', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');

  const result = await withTimeout(service.syncCandidatesToOsm([
    { osmType: 'way', osmId: 201 },
    { osmType: 'way', osmId: 202 }
  ], 'admin@example.com'), 1000);
  restore();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(result.ok, true);
  assert.equal(result.changesetId, 125);
  assert.equal(changesetBodies.length, 1);
  assert.match(changesetBodies[0], /Update architectural info:/);
  assert.match(changesetBodies[0], /2 buildings/);
  assert.equal(putBodies.length, 2);
  assert.ok(putBodies.every((body) => body.includes('changeset="125"')));

  const syncedRows = db.prepare(`
    SELECT sync_status, sync_changeset_id
    FROM user_edits.building_user_edits
    ORDER BY id
  `).all();
  assert.deepEqual(syncedRows.map((row) => row.sync_status), ['synced', 'synced']);
  assert.deepEqual(syncedRows.map((row) => Number(row.sync_changeset_id)), [125, 125]);
  assert.equal(refreshCalls, 0);
  assert.equal(searchRefreshCalls, 0);
});

test('syncCandidateToOsm rejects already published read-only candidates', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');
  const service = createOsmSyncService({ db, settingsSecret: 'test-secret' });
  const restore = installFetchMock([
    (url, init) => {
      if (url.endsWith('/oauth2/token') && init.method === 'POST') {
        return createFetchResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          scope: 'write_api write_changeset_comments'
        });
      }
      if (url.endsWith('/api/0.6/user/details')) {
        return createFetchResponse('<osm><user display_name="Test User"/></osm>');
      }
      return null;
    }
  ]);

  await service.saveSettings({
    providerName: 'OpenStreetMap',
    authBaseUrl: 'https://www.openstreetmap.org',
    apiBaseUrl: 'https://api.openstreetmap.org',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/admin/app-settings/osm/oauth/callback'
  }, 'admin@example.com');
  const oauth = await service.startOAuth('admin@example.com');
  await service.handleOauthCallback({
    code: 'auth-code',
    state: oauth.state
  });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 301, JSON.stringify({ name: 'Old Name' }), '2026-01-01T00:00:00Z');
  db.prepare(`
    INSERT INTO local.architectural_info (osm_type, osm_id, name, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 301, 'New Name', '2026-01-02T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, name, sync_status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(31, 'way', 301, 'admin@example.com', 'accepted', JSON.stringify(['name']), JSON.stringify({ name: 'Old Name' }), '2026-01-01T00:00:00Z', 'New Name', 'synced', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');

  await assert.rejects(
    () => service.syncCandidateToOsm('way', 301, 'admin@example.com'),
    (error) => {
      assert.equal(error.code, 'OSM_SYNC_ALREADY_PUBLISHED');
      assert.equal(error.status, 409);
      return true;
    }
  );

  restore();
});

test('syncCandidateToOsm rejects when OSM account is not connected', async () => {
  const db = createTestDb();
  const service = createOsmSyncService({ db, settingsSecret: 'test-secret' });

  await assert.rejects(
    () => service.syncCandidateToOsm('way', 101, 'admin@example.com'),
    (error) => {
      assert.equal(error.code, 'OSM_SYNC_NOT_CONNECTED');
      assert.equal(error.status, 503);
      return true;
    }
  );
});

test('cleanupSyncedLocalOverwritesAfterImport removes matching local overwrite and preserves history', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');
  let refreshCalls = 0;
  let searchRefreshCalls = 0;
  const service = createOsmSyncService({
    db,
    settingsSecret: 'test-secret',
    enqueueSearchIndexRefresh: () => {
      searchRefreshCalls += 1;
    },
    refreshDesignRefSuggestionsCache: () => {
      refreshCalls += 1;
      return new Promise(() => {});
    }
  });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 101, JSON.stringify({ name: 'New Name' }), '2026-01-10T00:00:00Z');
  db.prepare(`
    INSERT INTO local.architectural_info (osm_type, osm_id, name, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 101, 'New Name', '2026-01-10T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, name, sync_status, sync_attempted_at, sync_succeeded_at,
      sync_changeset_id, sync_summary_json, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1,
    'way',
    101,
    'admin@example.com',
    'accepted',
    JSON.stringify(['name']),
    JSON.stringify({ name: 'Old Name' }),
    '2026-01-01T00:00:00Z',
    'New Name',
    'synced',
    '2026-01-10T00:00:00Z',
    '2026-01-10T00:01:00Z',
    123,
    JSON.stringify({ changesetId: 123, syncedAt: '2026-01-10T00:01:00Z' }),
    '2026-01-10T00:01:00Z',
    '2026-01-10T00:00:00Z'
  );

  const result = await service.cleanupSyncedLocalOverwritesAfterImport();

  assert.equal(result.ok, true);
  assert.equal(result.cleaned.length, 1);

  const localRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM local.architectural_info
    WHERE osm_type = ? AND osm_id = ?
  `).get('way', 101);
  assert.equal(Number(localRow.total || 0), 0);

  const syncRow = db.prepare(`
    SELECT sync_status, sync_cleaned_at
    FROM user_edits.building_user_edits
    WHERE id = 1
  `).get();
  assert.equal(syncRow.sync_status, 'cleaned');
  assert.ok(syncRow.sync_cleaned_at);
  assert.equal(refreshCalls, 0);
  assert.equal(searchRefreshCalls, 1);
});

test('cleanupSyncedLocalOverwritesAfterImport ignores unrelated OSM tag changes outside synced fields', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');
  let searchRefreshCalls = 0;
  const service = createOsmSyncService({
    db,
    settingsSecret: 'test-secret',
    enqueueSearchIndexRefresh: () => {
      searchRefreshCalls += 1;
    }
  });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(
    'way',
    102,
    JSON.stringify({
      name: 'Synced Name',
      architect: 'Someone Else Now'
    }),
    '2026-01-10T00:00:00Z'
  );
  db.prepare(`
    INSERT INTO local.architectural_info (osm_type, osm_id, name, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 102, 'Synced Name', '2026-01-10T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, name, sync_status, sync_attempted_at, sync_succeeded_at,
      sync_changeset_id, sync_summary_json, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    2,
    'way',
    102,
    'admin@example.com',
    'accepted',
    JSON.stringify(['name']),
    JSON.stringify({ name: 'Old Name' }),
    '2026-01-01T00:00:00Z',
    'Synced Name',
    'synced',
    '2026-01-10T00:00:00Z',
    '2026-01-10T00:01:00Z',
    124,
    JSON.stringify({ changesetId: 124, syncedAt: '2026-01-10T00:01:00Z' }),
    '2026-01-10T00:01:00Z',
    '2026-01-10T00:00:00Z'
  );

  const result = await service.cleanupSyncedLocalOverwritesAfterImport();

  assert.equal(result.ok, true);
  assert.equal(result.cleaned.length, 1);

  const localRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM local.architectural_info
    WHERE osm_type = ? AND osm_id = ?
  `).get('way', 102);
  assert.equal(Number(localRow.total || 0), 0);
  assert.equal(searchRefreshCalls, 1);
});

test('cleanupSyncedLocalOverwritesAfterImport skips search index refresh for material-only overwrites', async () => {
  const db = createTestDb();
  db.prepare(`INSERT INTO app_general_settings (id, app_display_name, app_base_url) VALUES (1, ?, ?)`)
    .run('archimap', 'https://archimap.local');
  let searchRefreshCalls = 0;
  const service = createOsmSyncService({
    db,
    settingsSecret: 'test-secret',
    enqueueSearchIndexRefresh: () => {
      searchRefreshCalls += 1;
    }
  });

  db.prepare(`
    INSERT INTO osm.building_contours (osm_type, osm_id, tags_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 103, JSON.stringify({ material: 'brick' }), '2026-01-10T00:00:00Z');
  db.prepare(`
    INSERT INTO local.architectural_info (osm_type, osm_id, material, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('way', 103, 'brick', '2026-01-10T00:00:00Z');
  db.prepare(`
    INSERT INTO user_edits.building_user_edits (
      id, osm_type, osm_id, created_by, status, edited_fields_json, source_tags_json,
      source_osm_updated_at, material, sync_status, sync_attempted_at, sync_succeeded_at,
      sync_changeset_id, sync_summary_json, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    3,
    'way',
    103,
    'admin@example.com',
    'accepted',
    JSON.stringify(['material']),
    JSON.stringify({ material: 'brick' }),
    '2026-01-01T00:00:00Z',
    'brick',
    'synced',
    '2026-01-10T00:00:00Z',
    '2026-01-10T00:01:00Z',
    125,
    JSON.stringify({ changesetId: 125, syncedAt: '2026-01-10T00:01:00Z' }),
    '2026-01-10T00:01:00Z',
    '2026-01-10T00:00:00Z'
  );

  const result = await service.cleanupSyncedLocalOverwritesAfterImport();

  assert.equal(result.ok, true);
  assert.equal(result.cleaned.length, 1);
  assert.equal(searchRefreshCalls, 0);
});
