const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { pickIntegrationPort } = require('./test-ports');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSetCookie(raw) {
  const first = String(raw || '').split(';')[0];
  const [name, value] = first.split('=');
  if (!name || value == null) return null;
  return { name: name.trim(), value: value.trim() };
}

function setCookiesFromHeaders(cookieJar, headers) {
  if (typeof headers.getSetCookie === 'function') {
    for (const raw of headers.getSetCookie()) {
      const parsed = parseSetCookie(raw);
      if (parsed) cookieJar.set(parsed.name, parsed.value);
    }
    return;
  }
  const fallback = headers.get('set-cookie');
  if (!fallback) return;
  const parsed = parseSetCookie(fallback);
  if (parsed) cookieJar.set(parsed.name, parsed.value);
}

const ARCHI_RULE_KEYS = new Set(['name', 'style', 'levels', 'year_built', 'architect', 'address', 'description', 'archimap_description']);
const FILTER_MATCH_CANDIDATE_CAP = 50000;

function encodeOsmFeatureId(osmType, osmId) {
  const typeBit = osmType === 'relation' ? 1 : 0;
  return (Number(osmId) * 2) + typeBit;
}

function parseOsmKey(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(way|relation)\/(\d+)$/);
  if (!match) return null;
  const osmId = Number(match[2]);
  if (!Number.isInteger(osmId)) return null;
  return { osmType: match[1], osmId };
}

function normalizeTagValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.join(';');
  return String(value);
}

function hasMeaningfulValue(value) {
  const normalized = normalizeTagValue(value);
  return normalized != null && String(normalized).trim().length > 0;
}

function getRuleValue(item, key) {
  const archiInfo = item?.archiInfo && typeof item.archiInfo === 'object' ? item.archiInfo : {};
  if (key.startsWith('archi.')) return archiInfo[key.slice(6)];
  const sourceTags = item?.sourceTags && typeof item.sourceTags === 'object' ? item.sourceTags : {};
  if (key === 'colour') {
    if (hasMeaningfulValue(archiInfo.colour)) return archiInfo.colour;
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'building:colour')) return sourceTags['building:colour'];
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'colour')) return sourceTags.colour;
  }
  if (key === 'material') {
    if (hasMeaningfulValue(archiInfo.material)) return archiInfo.material;
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'building:material')) return sourceTags['building:material'];
    if (Object.prototype.hasOwnProperty.call(sourceTags, 'material')) return sourceTags.material;
  }
  if (ARCHI_RULE_KEYS.has(key) && hasMeaningfulValue(archiInfo[key])) return archiInfo[key];
  if (Object.prototype.hasOwnProperty.call(sourceTags, key)) return sourceTags[key];
  if (ARCHI_RULE_KEYS.has(key)) return archiInfo[key];
  return undefined;
}

function matchesFilterRule(item, rule) {
  const actualRaw = getRuleValue(item, rule.key);
  const actual = normalizeTagValue(actualRaw);
  const hasValue = actual != null && String(actual).trim().length > 0;
  if (rule.op === 'exists') return hasValue;
  if (rule.op === 'not_exists') return !hasValue;
  if (actual == null) return false;

  const left = String(actual).toLowerCase();
  const right = String(rule.value || '').trim().toLowerCase();
  if (rule.op === 'equals') return left === right;
  if (rule.op === 'not_equals') return left !== right;
  if (rule.op === 'starts_with') return left.startsWith(right);
  return left.includes(right);
}

function mapFilterDataRow(row) {
  let sourceTags: LooseRecord;
  try {
    sourceTags = row.tags_json ? JSON.parse(row.tags_json) : {};
  } catch {
    sourceTags = {};
  }
  const hasExtraInfo = row.info_osm_id != null;
  return {
    osmKey: `${row.osm_type}/${row.osm_id}`,
    sourceTags,
    archiInfo: hasExtraInfo
      ? {
        name: row.name,
        style: row.style,
        material: row.material,
        colour: row.colour,
        levels: row.levels,
        year_built: row.year_built,
        architect: row.architect,
        address: row.address,
        description: row.description,
        archimap_description: row.archimap_description || row.description || null
      }
      : null
  };
}

async function upsertFilterFixtures(connectionString, fixtures) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const fixture of fixtures) {
      await client.query(`
        INSERT INTO osm.building_contours (
          osm_type, osm_id, tags_json, min_lon, min_lat, max_lon, max_lat, geom, updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($8), 4326)),
          NOW()
        )
        ON CONFLICT (osm_type, osm_id) DO UPDATE SET
          tags_json = EXCLUDED.tags_json,
          min_lon = EXCLUDED.min_lon,
          min_lat = EXCLUDED.min_lat,
          max_lon = EXCLUDED.max_lon,
          max_lat = EXCLUDED.max_lat,
          geom = EXCLUDED.geom,
          updated_at = NOW()
      `, [
        fixture.osmType,
        fixture.osmId,
        JSON.stringify(fixture.tags || {}),
        fixture.minLon,
        fixture.minLat,
        fixture.maxLon,
        fixture.maxLat,
        fixture.geometryJson
      ]);

      if (fixture.archiInfo) {
        await client.query(`
          INSERT INTO local.architectural_info (
            osm_type, osm_id, name, style, material, colour, levels, year_built, architect, address, description, archimap_description, updated_by, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'postgres-runtime-test', NOW())
          ON CONFLICT (osm_type, osm_id) DO UPDATE SET
            name = EXCLUDED.name,
            style = EXCLUDED.style,
            material = EXCLUDED.material,
            colour = EXCLUDED.colour,
            levels = EXCLUDED.levels,
            year_built = EXCLUDED.year_built,
            architect = EXCLUDED.architect,
            address = EXCLUDED.address,
            description = EXCLUDED.description,
            archimap_description = EXCLUDED.archimap_description,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
        `, [
          fixture.osmType,
          fixture.osmId,
          fixture.archiInfo.name ?? null,
          fixture.archiInfo.style ?? null,
          fixture.archiInfo.material ?? null,
          fixture.archiInfo.colour ?? null,
          fixture.archiInfo.levels ?? null,
          fixture.archiInfo.year_built ?? null,
          fixture.archiInfo.architect ?? null,
          fixture.archiInfo.address ?? null,
          fixture.archiInfo.description ?? null,
          fixture.archiInfo.archimap_description ?? null
        ]);
      } else {
        await client.query(
          'DELETE FROM local.architectural_info WHERE osm_type = $1 AND osm_id = $2',
          [fixture.osmType, fixture.osmId]
        );
      }
    }
    await client.query(`
      INSERT INTO osm.building_contours_summary (singleton_id, total, last_updated, refreshed_at)
      SELECT 1, COUNT(*)::bigint, MAX(updated_at), NOW()
      FROM osm.building_contours
      ON CONFLICT (singleton_id) DO UPDATE SET
        total = EXCLUDED.total,
        last_updated = EXCLUDED.last_updated,
        refreshed_at = EXCLUDED.refreshed_at
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function cleanupFilterFixtures(connectionString, fixtures) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const fixture of fixtures) {
      await client.query(
        'DELETE FROM local.architectural_info WHERE osm_type = $1 AND osm_id = $2',
        [fixture.osmType, fixture.osmId]
      );
      await client.query(
        'DELETE FROM osm.building_contours WHERE osm_type = $1 AND osm_id = $2',
        [fixture.osmType, fixture.osmId]
      );
    }
    await client.query(`
      INSERT INTO osm.building_contours_summary (singleton_id, total, last_updated, refreshed_at)
      SELECT 1, COUNT(*)::bigint, MAX(updated_at), NOW()
      FROM osm.building_contours
      ON CONFLICT (singleton_id) DO UPDATE SET
        total = EXCLUDED.total,
        last_updated = EXCLUDED.last_updated,
        refreshed_at = EXCLUDED.refreshed_at
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function insertUserEditFixtures(connectionString, fixtures) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const fixture of fixtures) {
      await client.query(`
        INSERT INTO user_edits.building_user_edits (
          osm_type, osm_id, created_by, name, style, levels, year_built, architect, address, archimap_description, status, admin_comment, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
      `, [
        fixture.osmType,
        fixture.osmId,
        fixture.createdBy,
        fixture.name ?? null,
        fixture.style ?? null,
        fixture.levels ?? null,
        fixture.yearBuilt ?? null,
        fixture.architect ?? null,
        fixture.address ?? null,
        fixture.archimapDescription ?? null,
        fixture.status ?? 'pending',
        fixture.adminComment ?? null
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function cleanupUserEditFixtures(connectionString, fixtures) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const fixture of fixtures) {
      await client.query(
        'DELETE FROM user_edits.building_user_edits WHERE osm_type = $1 AND osm_id = $2 AND lower(trim(created_by)) = lower(trim($3))',
        [fixture.osmType, fixture.osmId, fixture.createdBy]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function buildExpectedAnonMatches(connectionString, payload) {
  const bbox = payload.bbox || {};
  const maxResults = Number(payload.maxResults || 12000);
  const rules = Array.isArray(payload.rules) ? payload.rules : [];
  const isHeavy = rules.some((rule) => String(rule?.op || '') === 'contains');
  const candidateLimit = Math.max(
    maxResults,
    Math.min(FILTER_MATCH_CANDIDATE_CAP, Math.max(maxResults * (isHeavy ? 8 : 6), 5000))
  );

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const rows = await client.query(`
      WITH env AS (
        SELECT ST_MakeEnvelope($1, $2, $3, $4, 4326) AS geom
      )
        SELECT
          bc.osm_type,
          bc.osm_id,
          bc.tags_json,
          ai.osm_id AS info_osm_id,
          ai.name,
          ai.style,
          ai.material,
          ai.colour,
          ai.levels,
          ai.year_built,
          ai.architect,
          ai.address,
          ai.description,
        ai.archimap_description,
        ai.updated_by,
        ai.updated_at
      FROM osm.building_contours bc
      LEFT JOIN local.architectural_info ai
        ON ai.osm_type = bc.osm_type AND ai.osm_id = bc.osm_id
      JOIN env
        ON bc.geom && env.geom
      WHERE ST_Intersects(bc.geom, env.geom)
      LIMIT $5
    `, [
      Number(bbox.west),
      Number(bbox.south),
      Number(bbox.east),
      Number(bbox.north),
      candidateLimit
    ]);

    const items = rows.rows.map(mapFilterDataRow);
    const matchedKeys = [];
    const matchedFeatureIds = [];
    let truncated = false;

    for (const item of items) {
      const ok = rules.every((rule) => matchesFilterRule(item, rule));
      if (!ok) continue;
      matchedKeys.push(item.osmKey);
      const parsed = parseOsmKey(item.osmKey);
      if (parsed) matchedFeatureIds.push(encodeOsmFeatureId(parsed.osmType, parsed.osmId));
      if (matchedKeys.length >= maxResults) {
        truncated = true;
        break;
      }
    }
    if (!truncated && rows.rows.length >= candidateLimit) {
      truncated = true;
    }
    return { matchedKeys, matchedFeatureIds, truncated };
  } finally {
    await client.end();
  }
}

test('postgres runtime: auth/admin flow and no sqlite file creation', async (t) => {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    console.warn('[postgres.runtime.integration] skipped: DATABASE_URL is not set');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-it-pg-'));
  const sqlitePaths = {
    archimap: path.join(tmpRoot, 'archimap.db'),
    osm: path.join(tmpRoot, 'osm.db'),
    local: path.join(tmpRoot, 'local-edits.db'),
    edits: path.join(tmpRoot, 'user-edits.db'),
    auth: path.join(tmpRoot, 'users.db')
  };
  const port = pickIntegrationPort('postgresRuntime');
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, ['--import', 'tsx', 'server.sveltekit.ts'], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DB_PROVIDER: 'postgres',
      DATABASE_URL: databaseUrl,
      AUTO_SYNC_ENABLED: 'false',
      AUTO_SYNC_ON_START: 'false',
      AUTO_SYNC_INTERVAL_HOURS: '0',
      SESSION_ALLOW_MEMORY_FALLBACK: 'true',
      SESSION_COOKIE_SECURE: 'false',
      REDIS_URL: 'redis://127.0.0.1:6399',
      SESSION_SECRET: 'postgres-integration-secret',
      APP_BASE_URL: baseUrl,
      ARCHIMAP_DB_PATH: sqlitePaths.archimap,
      OSM_DB_PATH: sqlitePaths.osm,
      LOCAL_EDITS_DB_PATH: sqlitePaths.local,
      USER_EDITS_DB_PATH: sqlitePaths.edits,
      USER_AUTH_DB_PATH: sqlitePaths.auth
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

  async function waitUntilReady(timeoutMs = 25000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const response = await fetch(`${baseUrl}/readyz`);
        if (response.ok) return;
      } catch {
        // ignore until server is reachable
      }
      await sleep(250);
    }
    throw new Error(`Postgres runtime did not become ready in ${timeoutMs}ms`);
  }

  async function createMasterAdmin({ email, password }: LooseRecord) {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(process.execPath, [
        '--import',
        'tsx',
        'scripts/create-master-admin.ts',
        `--email=${email}`,
        `--password=${password}`,
        '--first-name=Pg',
        '--last-name=Admin'
      ], {
        cwd: path.join(__dirname, '..', '..'),
        env: {
          ...process.env,
          DB_PROVIDER: 'postgres',
          DATABASE_URL: databaseUrl
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { output += chunk.toString(); });
      proc.on('error', reject);
      proc.on('exit', (code: number | null) => {
        if (code === 0) return resolve();
        return reject(new Error(`create-master-admin failed (code=${code})\n${output}`));
      });
    });
  }

  const cookieJar = new Map();
  async function callApi(pathname, options: LooseRecord = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookieJar.size > 0) {
      headers.cookie = [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers
    });
    setCookiesFromHeaders(cookieJar, response.headers);
    return response;
  }

  async function callAnonApi(pathname, options: LooseRecord = {}) {
    return fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: { ...(options.headers || {}) }
    });
  }

  try {
    await waitUntilReady();
    const adminEmail = `admin-pg-${Date.now()}@example.test`;
    const adminPassword = 'PgAdmin12345';
    await createMasterAdmin({ email: adminEmail, password: adminPassword });

    const login = await callApi('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: adminEmail,
        password: adminPassword
      })
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.equal(loginBody.ok, true);
    const csrfToken = String(loginBody.csrfToken || '');
    assert.ok(csrfToken.length > 10);

    const users = await callApi('/api/admin/users');
    assert.equal(users.status, 200);
    const usersBody = await users.json();
    assert.ok(Array.isArray(usersBody.items));
    assert.ok(usersBody.items.some((item) => String(item.email || '') === adminEmail));

    const contours = await callApi('/api/contours-status');
    assert.equal(contours.status, 200);
    const contoursBody = await contours.json();
    assert.equal(typeof contoursBody.total, 'number');

    await t.test('filter-matches anon in postgres matches legacy JS semantics', async () => {
      const baseId = Number(`97${String(Date.now()).slice(-8)}`);
      const fixtures = [
        {
          osmType: 'way',
          osmId: baseId + 1,
          tags: { name: 'Alpha House', foo: 'bar', prefix: 'sample-one' },
          geometryJson: '{"type":"Polygon","coordinates":[[[-169.9990,10.0010],[-169.9970,10.0010],[-169.9970,10.0030],[-169.9990,10.0030],[-169.9990,10.0010]]]}',
          minLon: -169.9990,
          minLat: 10.0010,
          maxLon: -169.9970,
          maxLat: 10.0030,
          archiInfo: { name: 'Info Alpha', style: 'Modern', architect: 'Architect A' }
        },
        {
          osmType: 'relation',
          osmId: baseId + 2,
          tags: { name: 'Beta Hall', foo: 'baz', style: 'TagStyle', prefix: 'start-here' },
          geometryJson: '{"type":"Polygon","coordinates":[[[-169.9960,10.0040],[-169.9940,10.0040],[-169.9940,10.0060],[-169.9960,10.0060],[-169.9960,10.0040]]]}',
          minLon: -169.9960,
          minLat: 10.0040,
          maxLon: -169.9940,
          maxLat: 10.0060,
          archiInfo: { name: 'Info Beta', style: 'Classic' }
        },
        {
          osmType: 'way',
          osmId: baseId + 5,
          tags: { style: 'OSM Style', material: 'brick', colour: 'blue' },
          geometryJson: '{"type":"Polygon","coordinates":[[[-169.9910,10.0060],[-169.9895,10.0060],[-169.9895,10.0075],[-169.9910,10.0075],[-169.9910,10.0060]]]}',
          minLon: -169.9910,
          minLat: 10.0060,
          maxLon: -169.9895,
          maxLat: 10.0075,
          archiInfo: { style: 'Local Style', material: 'stone', colour: 'red' }
        },
        {
          osmType: 'way',
          osmId: baseId + 3,
          tags: { 'archi.style': 'Neo', name: null },
          geometryJson: '{"type":"Polygon","coordinates":[[[-169.9950,10.0070],[-169.9930,10.0070],[-169.9930,10.0090],[-169.9950,10.0090],[-169.9950,10.0070]]]}',
          minLon: -169.9950,
          minLat: 10.0070,
          maxLon: -169.9930,
          maxLat: 10.0090,
          archiInfo: { name: 'Gamma Tower', style: 'Brutalist', levels: 5 }
        },
        {
          osmType: 'way',
          osmId: baseId + 4,
          tags: { prefix: 'none' },
          geometryJson: '{"type":"Polygon","coordinates":[[[-169.9920,10.0020],[-169.9900,10.0020],[-169.9900,10.0040],[-169.9920,10.0040],[-169.9920,10.0020]]]}',
          minLon: -169.9920,
          minLat: 10.0020,
          maxLon: -169.9900,
          maxLat: 10.0040,
          archiInfo: null
        }
      ];

      const payloads = [
        {
          bbox: { west: -170.0000, south: 10.0000, east: -169.9890, north: 10.0100 },
          zoomBucket: 15,
          maxResults: 50,
          rules: [{ key: 'name', op: 'contains', value: 'alpha' }]
        },
        {
          bbox: { west: -170.0000, south: 10.0000, east: -169.9890, north: 10.0100 },
          zoomBucket: 15,
          maxResults: 50,
          rules: [{ key: 'archi.style', op: 'equals', value: 'neo' }]
        },
        {
          bbox: { west: -170.0000, south: 10.0000, east: -169.9890, north: 10.0100 },
          zoomBucket: 15,
          maxResults: 50,
          rules: [{ key: 'foo', op: 'not_equals', value: 'bar' }]
        },
        {
          bbox: { west: -170.0000, south: 10.0000, east: -169.9890, north: 10.0100 },
          zoomBucket: 15,
          maxResults: 50,
          rules: [{ key: 'prefix', op: 'starts_with', value: 'start' }]
        },
        {
          bbox: { west: -170.0000, south: 10.0000, east: -169.9890, north: 10.0100 },
          zoomBucket: 15,
          maxResults: 50,
          rules: [{ key: 'style', op: 'exists', value: '' }]
        },
        {
          bbox: { west: -170.0000, south: 10.0000, east: -169.9890, north: 10.0100 },
          zoomBucket: 15,
          maxResults: 50,
          rules: [{ key: 'material', op: 'equals', value: 'stone' }]
        },
        {
          bbox: { west: -170.0000, south: 10.0000, east: -169.9890, north: 10.0100 },
          zoomBucket: 15,
          maxResults: 50,
          rules: [{ key: 'colour', op: 'equals', value: 'red' }]
        },
        {
          bbox: { west: -170.0000, south: 10.0000, east: -169.9890, north: 10.0100 },
          zoomBucket: 15,
          maxResults: 50,
          rules: [{ key: 'name', op: 'not_exists', value: '' }]
        }
      ];

      try {
        await upsertFilterFixtures(databaseUrl, fixtures);

        for (let i = 0; i < payloads.length; i += 1) {
          const payload = payloads[i];
          const expected = await buildExpectedAnonMatches(databaseUrl, payload);

          const response = await callAnonApi('/api/buildings/filter-matches', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          });
          assert.equal(response.status, 200);
          const body = await response.json();

          const actualKeys = [...(body.matchedKeys || [])].sort();
          const expectedKeys = [...expected.matchedKeys].sort();
          assert.deepEqual(actualKeys, expectedKeys);

          const actualFeatureIds = [...(body.matchedFeatureIds || [])].map((value) => Number(value)).sort((a, b) => a - b);
          const expectedFeatureIds = [...expected.matchedFeatureIds].map((value) => Number(value)).sort((a, b) => a - b);
          assert.deepEqual(actualFeatureIds, expectedFeatureIds);

          assert.equal(Boolean(body?.meta?.truncated), expected.truncated);
          assert.equal(Boolean(body?.meta?.cacheHit), false);
          assert.equal(typeof body?.meta?.rulesHash, 'string');
          assert.equal(typeof body?.meta?.bboxHash, 'string');

          if (i === 0) {
            const cached = await callAnonApi('/api/buildings/filter-matches', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload)
            });
            assert.equal(cached.status, 200);
            const cachedBody = await cached.json();
            assert.equal(Boolean(cachedBody?.meta?.cacheHit), true);
            assert.deepEqual([...(cachedBody.matchedKeys || [])].sort(), expectedKeys);
          }
        }
      } finally {
        await cleanupFilterFixtures(databaseUrl, fixtures);
      }
    });

    await t.test('building endpoints return personal edits in postgres', async () => {
      const baseId = Number(`98${String(Date.now()).slice(-8)}`);
      const fixtures = [
        {
          osmType: 'way',
          osmId: baseId + 1,
          tags: { name: 'Draft Overlay House' },
          geometryJson: '{"type":"Polygon","coordinates":[[[-169.9890,10.0010],[-169.9870,10.0010],[-169.9870,10.0030],[-169.9890,10.0030],[-169.9890,10.0010]]]}',
          minLon: -169.9890,
          minLat: 10.0010,
          maxLon: -169.9870,
          maxLat: 10.0030,
          archiInfo: null
        }
      ];
      const editFixtures = [
        {
          osmType: 'way',
          osmId: baseId + 1,
          createdBy: adminEmail,
          name: 'Черновик пользователя',
          style: 'Constructivism',
          address: 'Тестовый адрес, 1',
          archimapDescription: 'Локальное описание',
          status: 'pending'
        }
      ];

      try {
        await upsertFilterFixtures(databaseUrl, fixtures);
        await insertUserEditFixtures(databaseUrl, editFixtures);

        const buildingResponse = await callApi(`/api/building/way/${baseId + 1}`);
        assert.equal(buildingResponse.status, 200);
        const buildingBody = await buildingResponse.json();
        assert.equal(buildingBody?.properties?.osm_key, `way/${baseId + 1}`);
        assert.equal(buildingBody?.properties?.archiInfo?.name, 'Черновик пользователя');
        assert.equal(buildingBody?.properties?.archiInfo?.review_status, 'pending');
        assert.equal(buildingBody?.properties?.archiInfo?.updated_by, adminEmail);

        const filterDataResponse = await callApi('/api/buildings/filter-data', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ keys: [`way/${baseId + 1}`] })
        });
        assert.equal(filterDataResponse.status, 200);
        const filterDataBody = await filterDataResponse.json();
        assert.equal(Array.isArray(filterDataBody.items), true);
        assert.equal(filterDataBody.items.length, 1);
        assert.equal(filterDataBody.items[0]?.osmKey, `way/${baseId + 1}`);
        assert.equal(filterDataBody.items[0]?.archiInfo?.name, 'Черновик пользователя');
        assert.equal(filterDataBody.items[0]?.archiInfo?.review_status, 'pending');
        assert.equal(filterDataBody.items[0]?.archiInfo?.updated_by, adminEmail);
      } finally {
        await cleanupUserEditFixtures(databaseUrl, editFixtures);
        await cleanupFilterFixtures(databaseUrl, fixtures);
      }
    });

    for (const sqlitePath of Object.values(sqlitePaths)) {
      assert.equal(fs.existsSync(sqlitePath), false, `SQLite file should not be created in postgres mode: ${sqlitePath}`);
    }
  } finally {
    if (server.exitCode == null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  if (server.exitCode && server.exitCode !== 0) {
    throw new Error(`Postgres runtime server exited with code ${server.exitCode}\n${serverOutput}`);
  }
});
