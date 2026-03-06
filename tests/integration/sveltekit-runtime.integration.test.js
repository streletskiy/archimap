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
  const getSetCookie = headers.getSetCookie;
  if (typeof getSetCookie === 'function') {
    for (const raw of getSetCookie.call(headers)) {
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

test('integration: sveltekit runtime serves api parity', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-sveltekit-it-'));
  const port = 3900 + Math.floor(Math.random() * 400);
  const baseUrl = `http://127.0.0.1:${port}`;
  const pmtilesFileName = `sveltekit-test-buildings-${Date.now()}.pmtiles`;
  const repoDataDir = path.join(__dirname, '..', '..', 'data');
  const pmtilesPath = path.join(repoDataDir, pmtilesFileName);
  fs.mkdirSync(repoDataDir, { recursive: true });
  fs.writeFileSync(pmtilesPath, Buffer.alloc(4096, 13));

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
      SESSION_SECRET: 'sveltekit-runtime-test-secret',
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
      USER_AUTH_DB_PATH: path.join(tempRoot, 'users.db'),
      BUILDINGS_PMTILES_FILE: pmtilesFileName
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  server.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });

  async function waitUntilReady(timeoutMs = 20000) {
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
    throw new Error(`SvelteKit runtime did not become ready in ${timeoutMs}ms`);
  }

  async function createMasterAdmin({ email, password }) {
    await new Promise((resolve, reject) => {
      const script = spawn(process.execPath, [
        'scripts/create-master-admin.js',
        `--email=${email}`,
        `--password=${password}`
      ], {
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
  async function call(pathname, options = {}) {
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

    const health = await call('/healthz');
    assert.equal(health.status, 200);
    const ready = await call('/readyz');
    assert.equal(ready.status, 200);
    const metrics = await call('/metrics');
    assert.equal(metrics.status, 200);

    const appPage = await call('/app');
    assert.equal(appPage.status, 200);
    const appHtml = await appPage.text();
    assert.match(appHtml, /<html/i);

    const shortSearch = await call('/api/search-buildings?q=a');
    assert.equal(shortSearch.status, 400);

    const version = await call('/api/version');
    assert.equal(version.status, 200);
    const versionBody = await version.json();
    assert.equal(typeof versionBody.version, 'string');

    await createMasterAdmin({
      email: 'sveltekit-admin@example.com',
      password: '12345678'
    });

    const login = await call('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'sveltekit-admin@example.com',
        password: '12345678'
      })
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    const csrfToken = String(loginBody?.csrfToken || '');
    assert.ok(csrfToken.length > 10);

    const me = await call('/api/me');
    assert.equal(me.status, 200);
    const meBody = await me.json();
    assert.equal(meBody?.authenticated, true);
  } finally {
    if (server.exitCode == null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(pmtilesPath, { force: true });
  }

  if (server.exitCode && server.exitCode !== 0) {
    throw new Error(`SvelteKit runtime exited with code ${server.exitCode}\n${serverOutput}`);
  }
});
