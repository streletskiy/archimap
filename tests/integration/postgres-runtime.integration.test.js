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

test('postgres runtime: auth/admin flow and no sqlite file creation', async () => {
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
  const port = 3900 + Math.floor(Math.random() * 300);
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, ['server.sveltekit.js'], {
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

  async function createMasterAdmin({ email, password }) {
    await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [
        'scripts/create-master-admin.js',
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
      proc.on('exit', (code) => {
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
