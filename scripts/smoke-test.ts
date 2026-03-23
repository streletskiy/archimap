const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TEST_PORT = 3322;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const PAGE_CHECKS = ['/', '/account', '/admin', '/info', '/app-config.js', '/api/contours-status'];
const SMOKE_DB_PROVIDER = String(process.env.DB_PROVIDER || 'sqlite').trim().toLowerCase() || 'sqlite';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toCookieMap(rawCookie) {
  const map = new Map();
  const cookieText = String(rawCookie || '').trim();
  if (!cookieText) return map;
  for (const chunk of cookieText.split(';')) {
    const [nameRaw, ...rest] = chunk.trim().split('=');
    const name = String(nameRaw || '').trim();
    const value = String(rest.join('=') || '').trim();
    if (!name) continue;
    map.set(name, value);
  }
  return map;
}

function mergeSetCookie(cookieHeader, setCookieHeaders) {
  const next = toCookieMap(cookieHeader);
  for (const raw of setCookieHeaders) {
    const firstPart = String(raw || '').split(';')[0] || '';
    const [nameRaw, ...rest] = firstPart.split('=');
    const name = String(nameRaw || '').trim();
    const value = String(rest.join('=') || '').trim();
    if (!name) continue;
    if (!value) {
      next.delete(name);
      continue;
    }
    next.set(name, value);
  }
  return [...next.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

class HttpSession {
  baseUrl: string;
  cookieHeader: string;

  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookieHeader = '';
  }

  async request(pathname, init: RequestInit = {}) {
    const headers = new Headers(init.headers || {});
    if (this.cookieHeader) {
      headers.set('cookie', this.cookieHeader);
    }
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...init,
      headers,
      redirect: 'manual'
    });
    const setCookie = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
    if (setCookie.length > 0) {
      this.cookieHeader = mergeSetCookie(this.cookieHeader, setCookie);
    }
    return response;
  }
}

async function waitForServerReady(timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/api/contours-status`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is not ready yet.
    }
    await sleep(300);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

async function assertOk(session, pathname) {
  const response = await session.request(pathname);
  if (!response.ok) {
    throw new Error(`${pathname} returned HTTP ${response.status}`);
  }
  return response;
}

async function checkEndpoints(session) {
  for (const pathname of PAGE_CHECKS) {
    await assertOk(session, pathname);
  }

  await assertOk(session, '/styles/positron-custom.json');

  const mapDataResp = await session.request('/api/search-buildings?q=test&limit=5');
  if (!mapDataResp.ok) {
    throw new Error(`/api/search-buildings returned HTTP ${mapDataResp.status}`);
  }

  const meResp = await session.request('/api/me');
  if (meResp.status !== 200) {
    throw new Error(`/api/me must return 200, got ${meResp.status}`);
  }
  const mePayload = await meResp.json().catch(() => null);
  if (!mePayload || mePayload.authenticated !== false) {
    throw new Error('/api/me must indicate authenticated=false for anonymous user');
  }

  const adminAnonResp = await session.request('/api/admin/users');
  if (![401, 403].includes(adminAnonResp.status)) {
    throw new Error(`/api/admin/users must return 401/403 for anonymous user, got ${adminAnonResp.status}`);
  }
}

async function checkAuthFlow(session, userAuthDbPath) {
  const email = `smoke-admin-${Date.now()}@example.test`;
  const password = 'SmokePass12345';

  const createAdmin = spawn(process.execPath, [
    '--import',
    'tsx',
    'scripts/create-master-admin.ts',
    `--email=${email}`,
    `--password=${password}`,
    '--first-name=Smoke',
    '--last-name=Admin'
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_PROVIDER: SMOKE_DB_PROVIDER,
      ...(SMOKE_DB_PROVIDER === 'sqlite' ? { USER_AUTH_DB_PATH: userAuthDbPath } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

    const createAdminOutput = await new Promise<string>((resolve, reject) => {
      let output = '';
      createAdmin.stdout.on('data', (chunk) => { output += chunk.toString(); });
      createAdmin.stderr.on('data', (chunk) => { output += chunk.toString(); });
      createAdmin.on('error', reject);
      createAdmin.on('exit', (code: number | null) => {
        if (code === 0) return resolve(output);
        return reject(new Error(`create-master-admin failed with code ${code}\n${output}`));
      });
  });
  if (!/master admin/i.test(createAdminOutput) && !/promoted to master admin/i.test(createAdminOutput)) {
    throw new Error('create-master-admin returned unexpected output');
  }

  const loginResp = await session.request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!loginResp.ok) {
    throw new Error(`/api/login failed: HTTP ${loginResp.status}`);
  }
  const loginPayload = await loginResp.json().catch(() => null);
  if (!loginPayload?.user || !loginPayload?.user?.isAdmin || !loginPayload?.csrfToken) {
    throw new Error('/api/login must return admin user payload and csrfToken');
  }

  const csrfToken = String(loginPayload.csrfToken || '').trim();
  const logoutResp = await session.request('/api/logout', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken }
  });
  if (!logoutResp.ok) {
    throw new Error(`/api/logout failed: HTTP ${logoutResp.status}`);
  }

  const meResp = await session.request('/api/me');
  const mePayload = await meResp.json().catch(() => null);
  if (!meResp.ok || mePayload?.authenticated !== false) {
    throw new Error('/api/me must indicate authenticated=false after logout');
  }

  const secondLoginResp = await session.request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!secondLoginResp.ok) {
    throw new Error(`/second /api/login failed: HTTP ${secondLoginResp.status}`);
  }

  const adminResp = await session.request('/api/admin/users');
  if (adminResp.status !== 200) {
    throw new Error(`/api/admin/users must return 200 for admin session, got ${adminResp.status}`);
  }
}

async function main() {
  const smokeDataDir = path.join(process.cwd(), 'tmp', `smoke-${Date.now()}`);
  fs.mkdirSync(smokeDataDir, { recursive: true });
  const userAuthDbPath = path.join(smokeDataDir, 'users.db');

  const child = spawn(process.execPath, ['--import', 'tsx', 'server.sveltekit.ts'], {
    env: {
      ...process.env,
      DB_PROVIDER: SMOKE_DB_PROVIDER,
      PORT: String(TEST_PORT),
      DATA_DIR: smokeDataDir,
      ...(SMOKE_DB_PROVIDER === 'sqlite'
        ? {
          ARCHIMAP_DB_PATH: path.join(smokeDataDir, 'archimap.db'),
          OSM_DB_PATH: path.join(smokeDataDir, 'osm.db'),
          LOCAL_EDITS_DB_PATH: path.join(smokeDataDir, 'local-edits.db'),
          USER_EDITS_DB_PATH: path.join(smokeDataDir, 'user-edits.db'),
          USER_AUTH_DB_PATH: userAuthDbPath
        }
        : {}),
      AUTO_SYNC_ENABLED: 'false',
      AUTO_SYNC_ON_START: 'false',
      SESSION_ALLOW_MEMORY_FALLBACK: 'true',
      SESSION_COOKIE_SECURE: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  child.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServerReady();
    const session = new HttpSession(BASE_URL);
    await checkEndpoints(session);
    await checkAuthFlow(session, userAuthDbPath);
    console.log('Smoke checks passed');
  } catch (error) {
    console.error('Smoke checks failed:', error.message);
    if (serverOutput.trim()) {
      console.error('Server output:\n' + serverOutput.trim());
    }
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
