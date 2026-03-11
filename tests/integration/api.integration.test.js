const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ensurePythonImporterDeps } = require('../../scripts/region-sync/python-extractor');

let pythonExtractorDepsSkipReason = null;
try {
  ensurePythonImporterDeps();
} catch (error) {
  pythonExtractorDepsSkipReason = String(error?.message || error || 'Python extractor dependencies are unavailable');
}

const pythonExtractorIntegrationTestOptions = pythonExtractorDepsSkipReason
  ? { skip: `python extractor deps unavailable: ${pythonExtractorDepsSkipReason}` }
  : {};

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

test('integration: auth/csrf/admin/search/system endpoints', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-it-'));
  const port = 3600 + Math.floor(Math.random() * 400);
  const baseUrl = `http://127.0.0.1:${port}`;
  const repoDataDir = path.join(__dirname, '..', '..', 'data');
  const generatedPmtilesPaths = [];

  const server = spawn(process.execPath, ['server.sveltekit.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      METRICS_ENABLED: 'true',
      AUTO_SYNC_ENABLED: 'false',
      AUTO_SYNC_ON_START: 'false',
      AUTO_SYNC_INTERVAL_HOURS: '0',
      SESSION_ALLOW_MEMORY_FALLBACK: 'true',
      SESSION_COOKIE_SECURE: 'false',
      REDIS_URL: 'redis://127.0.0.1:6399',
      SESSION_SECRET: 'integration-test-secret',
      APP_BASE_URL: baseUrl,
      DB_PROVIDER: 'sqlite',
      SMTP_URL: '',
      SMTP_HOST: '',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_USER: '',
      SMTP_PASS: '',
      EMAIL_FROM: '',
      ARCHIMAP_DB_PATH: path.join(tempRoot, 'archimap.db'),
      LOCAL_EDITS_DB_PATH: path.join(tempRoot, 'local-edits.db'),
      USER_EDITS_DB_PATH: path.join(tempRoot, 'user-edits.db'),
      USER_AUTH_DB_PATH: path.join(tempRoot, 'users.db')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

  async function waitUntilReady(timeoutMs = 15000) {
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
    throw new Error(`Server did not become ready in ${timeoutMs}ms`);
  }

  async function createMasterAdmin({
    email,
    password,
    firstName,
    lastName
  }) {
    const args = [
      'scripts/create-master-admin.js',
      `--email=${email}`,
      `--password=${password}`
    ];
    if (firstName) args.push(`--first-name=${firstName}`);
    if (lastName) args.push(`--last-name=${lastName}`);

    await new Promise((resolve, reject) => {
      const script = spawn(process.execPath, args, {
        cwd: path.join(__dirname, '..', '..'),
        env: {
          ...process.env,
          DB_PROVIDER: 'sqlite',
          USER_AUTH_DB_PATH: path.join(tempRoot, 'users.db')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      script.stdout.on('data', (chunk) => { output += chunk.toString(); });
      script.stderr.on('data', (chunk) => { output += chunk.toString(); });
      script.on('error', reject);
      script.on('exit', (code) => {
        if (code === 0) return resolve();
        return reject(new Error(`create-master-admin failed (code=${code})\n${output}`));
      });
    });
  }

  const cookieJar = new Map();
  async function callApi(pathname, options = {}) {
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

  try {
    await t.test('startup + system endpoints', async () => {
      await waitUntilReady();

      const health = await callApi('/healthz');
      assert.equal(health.status, 200);
      const healthBody = await health.json();
      assert.equal(healthBody.ok, true);
      assert.equal(typeof healthBody.version?.version, 'string');
      assert.equal(typeof healthBody.version?.git?.commit, 'string');

      const version = await callApi('/api/version');
      assert.equal(version.status, 200);
      const versionBody = await version.json();
      assert.equal(typeof versionBody.version, 'string');
      assert.equal(typeof versionBody.git?.describe, 'string');
      assert.equal(typeof versionBody.git?.commit, 'string');
      assert.equal(typeof versionBody.buildTime, 'string');

      const ready = await callApi('/readyz');
      assert.equal(ready.status, 200);
      const readyBody = await ready.json();
      assert.equal(readyBody.ok, true);

      const metrics = await callApi('/metrics');
      assert.equal(metrics.status, 200);
      const metricsText = await metrics.text();
      assert.match(metricsText, /archimap_http_requests_total/);

      const mainPage = await callApi('/');
      assert.equal(mainPage.status, 200);
      const csp = String(mainPage.headers.get('content-security-policy') || '');
      assert.ok(csp.length > 0);
      assert.equal(/\bscript-src\s[^;]*unsafe-inline/.test(csp), false);
      assert.equal(/\bstyle-src\s[^;]*unsafe-inline/.test(csp), false);
      assert.equal(mainPage.headers.get('x-content-type-options'), 'nosniff');
      const html = await mainPage.text();
      assert.equal(/cdn|unpkg|cdnjs|fonts\.googleapis/i.test(html), false);

      const appConfig = await callApi('/app-config.js');
      assert.equal(appConfig.status, 200);
      const appConfigText = await appConfig.text();
      assert.match(appConfigText, /window\.__ARCHIMAP_CONFIG/);
      assert.match(appConfigText, /"mapSelection":\{"debug":false\}/);
    });

    await t.test('registration does not depend on bootstrap first admin', async () => {
      const registerStart = await callApi('/api/register/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'user-no-admin@example.com',
          password: '12345678',
          firstName: 'Regular',
          lastName: 'User',
          acceptTerms: true,
          acceptPrivacy: true
        })
      });

      // Registration is enabled, but SMTP is not configured in this test.
      // The key expectation: no "bootstrap admin disabled" style block (403).
      assert.equal(registerStart.status, 503);
      const registerBody = await registerStart.json();
      assert.match(String(registerBody.error || ''), /Отправка писем не настроена/);
    });

    let csrfToken = '';
    await t.test('create master admin via CLI + login + csrf-protected profile update', async () => {
      await createMasterAdmin({
        email: 'admin@example.com',
        password: '12345678',
        firstName: 'Admin',
        lastName: 'User'
      });

      const login = await callApi('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@example.com',
          password: '12345678'
        })
      });
      assert.equal(login.status, 200);
      const loginBody = await login.json();
      assert.equal(loginBody.ok, true);
      csrfToken = String(loginBody.csrfToken || '');
      assert.ok(csrfToken.length > 10);

      const profileNoCsrf = await callApi('/api/account/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ firstName: 'NoCsrf' })
      });
      assert.equal(profileNoCsrf.status, 403);

      const profileOk = await callApi('/api/account/profile', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({ firstName: 'Updated', lastName: 'Admin' })
      });
      assert.equal(profileOk.status, 200);
      const profileBody = await profileOk.json();
      assert.equal(profileBody.ok, true);
    });

    await t.test('admin and search endpoints', async () => {
      const users = await callApi('/api/admin/users');
      assert.equal(users.status, 200);
      const usersBody = await users.json();
      assert.ok(Array.isArray(usersBody.items));
      assert.ok(usersBody.items.some((item) => String(item.email || '') === 'admin@example.com'));

      const shortQuery = await callApi('/api/search-buildings?q=a');
      assert.equal(shortQuery.status, 400);
      const searchBody = await shortQuery.json();
      assert.match(String(searchBody.error || ''), /Минимальная длина/);

      const invalidBbox = await callApi('/api/search-buildings?q=test&west=44&south=56&east=44.1');
      assert.equal(invalidBbox.status, 400);

      const searchOk = await callApi('/api/search-buildings?q=test&limit=5');
      assert.equal(searchOk.status, 200);
      const searchOkBody = await searchOk.json();
      assert.equal(typeof searchOkBody.total, 'number');
      const searchEtag = String(searchOk.headers.get('etag') || '');
      assert.ok(searchEtag.length > 0);

      const searchNotModified = await callApi('/api/search-buildings?q=test&limit=5', {
        headers: { 'if-none-match': searchEtag }
      });
      assert.equal(searchNotModified.status, 304);

      const mapSearch = await callApi('/api/search-buildings-map?q=test&west=44&south=56&east=44.1&north=56.1');
      assert.equal(mapSearch.status, 200);
      const mapSearchBody = await mapSearch.json();
      assert.equal(typeof mapSearchBody.total, 'number');
      assert.equal(typeof mapSearchBody.truncated, 'boolean');
      assert.ok(Array.isArray(mapSearchBody.items));
    });

    await t.test('admin data settings endpoints support create/rename/delete flow for regions', pythonExtractorIntegrationTestOptions, async () => {
      const dataSettings = await callApi('/api/admin/app-settings/data');
      assert.equal(dataSettings.status, 200);
      const dataSettingsBody = await dataSettings.json();
      assert.equal(dataSettingsBody?.ok, true);
      assert.ok(Array.isArray(dataSettingsBody?.item?.regions));

      const resolveExtract = await callApi('/api/admin/app-settings/data/regions/resolve-extract', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({
          query: 'Antarctica'
        })
      });
      assert.equal(resolveExtract.status, 200);
      const resolveExtractBody = await resolveExtract.json();
      assert.equal(resolveExtractBody?.ok, true);
      assert.ok(Array.isArray(resolveExtractBody?.items));
      assert.ok(resolveExtractBody.items.some((item) => String(item?.extractId || '') === 'geofabrik_antarctica'));

      const rejectLegacyPayload = await callApi('/api/admin/app-settings/data/regions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({
          region: {
            name: 'Legacy Payload',
            slug: 'legacy-payload',
            sourceType: 'extract',
            sourceValue: 'Antarctica',
            extractSource: 'geofabrik',
            extractId: 'geofabrik_antarctica',
            extractLabel: 'antarctica',
            enabled: true,
            autoSyncEnabled: false,
            autoSyncOnStart: false,
            autoSyncIntervalHours: 0,
            pmtilesMinZoom: 12,
            pmtilesMaxZoom: 15,
            sourceLayer: 'buildings'
          }
        })
      });
      assert.equal(rejectLegacyPayload.status, 400);
      const rejectLegacyBody = await rejectLegacyPayload.json();
      assert.match(String(rejectLegacyBody?.error || ''), /sourceValue/i);

      const createRegion = await callApi('/api/admin/app-settings/data/regions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({
          region: {
            name: 'Test Region',
            slug: 'test-region',
            sourceType: 'extract',
            searchQuery: 'Antarctica',
            extractSource: 'geofabrik',
            extractId: 'geofabrik_antarctica',
            extractLabel: 'antarctica',
            enabled: true,
            autoSyncEnabled: false,
            autoSyncOnStart: false,
            autoSyncIntervalHours: 0,
            pmtilesMinZoom: 12,
            pmtilesMaxZoom: 15,
            sourceLayer: 'buildings'
          }
        })
      });
      assert.equal(createRegion.status, 200);
      const createRegionBody = await createRegion.json();
      assert.equal(createRegionBody?.ok, true);
      assert.equal(createRegionBody?.item?.slug, 'test-region');

      const regions = await callApi('/api/admin/app-settings/data/regions');
      assert.equal(regions.status, 200);
      const regionsBody = await regions.json();
      assert.ok(Array.isArray(regionsBody?.items));
      let region = regionsBody.items.find((item) => String(item?.slug || '') === 'test-region');
      assert.ok(region);
      assert.equal(region.lastSyncStatus, 'idle');

      const runs = await callApi(`/api/admin/app-settings/data/regions/${region.id}/runs`);
      assert.equal(runs.status, 200);
      const runsBody = await runs.json();
      assert.equal(runsBody?.ok, true);
      assert.ok(Array.isArray(runsBody?.items));
      assert.equal(runsBody.items.length, 0);

      const renameRegion = await callApi('/api/admin/app-settings/data/regions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({
          region: {
            id: region.id,
            name: 'Renamed Test Region',
            slug: 'renamed-test-region',
            sourceType: 'extract',
            searchQuery: 'Antarctica',
            extractSource: 'geofabrik',
            extractId: 'geofabrik_antarctica',
            extractLabel: 'antarctica',
            enabled: true,
            autoSyncEnabled: false,
            autoSyncOnStart: false,
            autoSyncIntervalHours: 0,
            pmtilesMinZoom: 12,
            pmtilesMaxZoom: 15,
            sourceLayer: 'buildings'
          }
        })
      });
      assert.equal(renameRegion.status, 200);
      const renameRegionBody = await renameRegion.json();
      assert.equal(renameRegionBody?.ok, true);
      assert.equal(renameRegionBody?.item?.id, region.id);
      assert.equal(renameRegionBody?.item?.slug, 'renamed-test-region');
      assert.equal(renameRegionBody?.item?.name, 'Renamed Test Region');

      const regionsAfterRename = await callApi('/api/admin/app-settings/data/regions');
      assert.equal(regionsAfterRename.status, 200);
      const regionsAfterRenameBody = await regionsAfterRename.json();
      region = regionsAfterRenameBody.items.find((item) => Number(item?.id || 0) === Number(region.id));
      assert.ok(region);
      assert.equal(region.slug, 'renamed-test-region');
      assert.equal(region.name, 'Renamed Test Region');

      const regionPmtilesPath = path.join(repoDataDir, 'regions', `buildings-region-${region.slug}.pmtiles`);
      fs.mkdirSync(path.dirname(regionPmtilesPath), { recursive: true });
      fs.writeFileSync(regionPmtilesPath, Buffer.alloc(4096, 7));
      generatedPmtilesPaths.push(regionPmtilesPath);

      const response = await callApi(`/api/data/regions/${region.id}/pmtiles`, {
        headers: {
          range: 'bytes=0-1023'
        }
      });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.match(String(response.headers.get('content-range') || ''), /^bytes 0-1023\/\d+$/);
      const payload = new Uint8Array(await response.arrayBuffer());
      assert.equal(payload.length, 1024);

      const full = await callApi(`/api/data/regions/${region.id}/pmtiles`);
      assert.equal(full.status, 200);
      const pmtilesEtag = String(full.headers.get('etag') || '');
      assert.ok(pmtilesEtag.length > 0);
      assert.ok(String(full.headers.get('last-modified') || '').length > 0);
      await full.arrayBuffer();

      const notModified = await callApi(`/api/data/regions/${region.id}/pmtiles`, {
        headers: { 'if-none-match': pmtilesEtag }
      });
      assert.equal(notModified.status, 304);

      const deleteRegion = await callApi(`/api/admin/app-settings/data/regions/${region.id}`, {
        method: 'DELETE',
        headers: {
          'x-csrf-token': csrfToken
        }
      });
      const deleteRegionBody = await deleteRegion.json().catch(async () => ({ error: await deleteRegion.text() }));
      assert.equal(deleteRegion.status, 200, JSON.stringify(deleteRegionBody));
      assert.equal(deleteRegionBody?.ok, true);
      assert.equal(deleteRegionBody?.item?.region?.id, region.id, JSON.stringify(deleteRegionBody));

      const regionsAfterDelete = await callApi('/api/admin/app-settings/data/regions');
      assert.equal(regionsAfterDelete.status, 200);
      const regionsAfterDeleteBody = await regionsAfterDelete.json();
      assert.equal(regionsAfterDeleteBody.items.some((item) => Number(item?.id || 0) === Number(region.id)), false);
    });

    await t.test('filter-matches endpoint validates input, returns meta and uses cache', async () => {
      const invalid = await callApi('/api/buildings/filter-matches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bbox: { west: 'x', south: 0, east: 1, north: 1 },
          rules: []
        })
      });
      assert.equal(invalid.status, 400);

      const emptyRules = await callApi('/api/buildings/filter-matches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bbox: { west: 44, south: 56, east: 44.02, north: 56.02 },
          zoomBucket: 14,
          rules: []
        })
      });
      assert.equal(emptyRules.status, 200);
      const emptyBody = await emptyRules.json();
      assert.deepEqual(emptyBody.matchedKeys, []);
      assert.equal(Boolean(emptyBody?.meta?.cacheHit), false);
      assert.equal(typeof emptyBody?.meta?.elapsedMs, 'number');
      assert.equal(typeof emptyBody?.meta?.rulesHash, 'string');
      assert.equal(typeof emptyBody?.meta?.bboxHash, 'string');

      const payload = {
        bbox: { west: 44, south: 56, east: 44.02, north: 56.02 },
        zoomBucket: 14,
        rules: [{ key: 'name', op: 'contains', value: 'test' }],
        maxResults: 15
      };

      const first = await callApi('/api/buildings/filter-matches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      assert.equal(first.status, 200);
      const firstBody = await first.json();
      assert.ok(Array.isArray(firstBody?.matchedKeys));
      assert.ok(Array.isArray(firstBody?.matchedFeatureIds));
      assert.equal(typeof firstBody?.meta?.truncated, 'boolean');
      assert.equal(Boolean(firstBody?.meta?.cacheHit), false);

      const second = await callApi('/api/buildings/filter-matches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      assert.equal(second.status, 200);
      const secondBody = await second.json();
      assert.equal(Boolean(secondBody?.meta?.cacheHit), true);
      assert.equal(secondBody?.meta?.rulesHash, firstBody?.meta?.rulesHash);
      assert.equal(secondBody?.meta?.bboxHash, firstBody?.meta?.bboxHash);
    });

    await t.test('filter-matches-batch endpoint validates input, returns items and uses cache', async () => {
      const invalid = await callApi('/api/buildings/filter-matches-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bbox: { west: 44, south: 56, east: 44.02, north: 56.02 },
          requests: 'bad'
        })
      });
      assert.equal(invalid.status, 400);

      const payload = {
        bbox: { west: 44, south: 56, east: 44.02, north: 56.02 },
        zoomBucket: 14,
        requests: [
          {
            id: 'contains-test',
            rules: [{ key: 'name', op: 'contains', value: 'test' }],
            maxResults: 15
          },
          {
            id: 'exists-name',
            rules: [{ key: 'name', op: 'exists', value: '' }],
            maxResults: 15
          }
        ]
      };

      const first = await callApi('/api/buildings/filter-matches-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      assert.equal(first.status, 200);
      const firstBody = await first.json();
      assert.ok(Array.isArray(firstBody?.items));
      assert.equal(firstBody.items.length, 2);
      assert.equal(firstBody.items[0]?.id, 'contains-test');
      assert.ok(Array.isArray(firstBody.items[0]?.matchedKeys));
      assert.equal(typeof firstBody.items[0]?.meta?.truncated, 'boolean');
      assert.equal(Boolean(firstBody.items[0]?.meta?.cacheHit), false);

      const second = await callApi('/api/buildings/filter-matches-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      assert.equal(second.status, 200);
      const secondBody = await second.json();
      assert.equal(secondBody.items.length, 2);
      assert.equal(Boolean(secondBody.items[0]?.meta?.cacheHit), true);
    });

  } finally {
    if (server.exitCode == null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    for (const filePath of generatedPmtilesPaths) {
      fs.rmSync(filePath, { force: true });
    }
  }

  if (server.exitCode && server.exitCode !== 0) {
    throw new Error(`Server exited with code ${server.exitCode}\n${serverOutput}`);
  }
});
