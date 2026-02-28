const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

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

  const server = spawn(process.execPath, ['server.js'], {
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
      REDIS_URL: 'redis://127.0.0.1:6399',
      SESSION_SECRET: 'integration-test-secret',
      APP_BASE_URL: baseUrl,
      ARCHIMAP_DB_PATH: path.join(tempRoot, 'archimap.db'),
      LOCAL_EDITS_DB_PATH: path.join(tempRoot, 'local-edits.db'),
      USER_EDITS_DB_PATH: path.join(tempRoot, 'user-edits.db'),
      USER_AUTH_DB_PATH: path.join(tempRoot, 'users.db'),
      BUILDINGS_PMTILES_FILE: 'test-buildings.pmtiles'
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

      const ready = await callApi('/readyz');
      assert.equal(ready.status, 200);
      const readyBody = await ready.json();
      assert.equal(readyBody.ok, true);

      const metrics = await callApi('/metrics');
      assert.equal(metrics.status, 200);
      const metricsText = await metrics.text();
      assert.match(metricsText, /archimap_http_requests_total/);
    });

    let csrfToken = '';
    await t.test('bootstrap registration + csrf-protected profile update', async () => {
      const registerStart = await callApi('/api/register/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@example.com',
          password: '12345678',
          firstName: 'Admin',
          lastName: 'User'
        })
      });
      assert.equal(registerStart.status, 200);
      const registerBody = await registerStart.json();
      assert.equal(registerBody.ok, true);
      assert.equal(registerBody.directSignup, true);
      assert.equal(registerBody.bootstrapAdmin, true);
      csrfToken = String(registerBody.csrfToken || '');
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
    });
  } finally {
    if (server.exitCode == null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  if (server.exitCode && server.exitCode !== 0) {
    throw new Error(`Server exited with code ${server.exitCode}\n${serverOutput}`);
  }
});
