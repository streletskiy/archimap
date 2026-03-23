const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { test, expect } = require('@playwright/test');

const PORT = 4150 + Math.floor(Math.random() * 120);
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server;
let tmpRoot;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady(url, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${url}/readyz`);
      if (response.ok) return;
    } catch {
      // ignore while booting
    }
    await sleep(250);
  }
  throw new Error('Server did not become ready for e2e');
}

test.beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-nav-e2e-'));

  server = spawn(process.execPath, ['--import', 'tsx', 'server.sveltekit.ts'], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...process.env,
      DB_PROVIDER: 'sqlite',
      PORT: String(PORT),
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      METRICS_ENABLED: 'false',
      AUTO_SYNC_ENABLED: 'false',
      AUTO_SYNC_ON_START: 'false',
      SESSION_ALLOW_MEMORY_FALLBACK: 'true',
      SESSION_COOKIE_SECURE: 'false',
      SESSION_SECRET: 'e2e-secret-value',
      APP_BASE_URL: BASE_URL,
      ARCHIMAP_DB_PATH: path.join(tmpRoot, 'archimap.db'),
      LOCAL_EDITS_DB_PATH: path.join(tmpRoot, 'local-edits.db'),
      USER_EDITS_DB_PATH: path.join(tmpRoot, 'user-edits.db'),
      USER_AUTH_DB_PATH: path.join(tmpRoot, 'users.db')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await waitReady(BASE_URL);
});

test.afterAll(async () => {
  if (server && server.exitCode == null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

async function assertMapPreservedViaInfo(page, clickTarget) {
  const startUrl = `${BASE_URL}/app?lat=56.325304&lng=44.01357&z=15.1`;
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.maplibregl-canvas')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200);

  await page.getByRole('link', { name: 'Information' }).click();
  await expect(page).toHaveURL(/\/app\/info/);

  await clickTarget();
  await expect(page).toHaveURL(/\/app/);

  await expect(page).toHaveURL(/lat=56\.325304/);
  await expect(page).toHaveURL(/lng=44\.01357/);
  await expect(page).toHaveURL(/z=15\.1/);
}

test('logo preserves map camera from info page', async ({ page }) => {
  await assertMapPreservedViaInfo(page, () => page.locator('.logo').click());
});

test('top navigation map link preserves map camera from info page', async ({ page }) => {
  await assertMapPreservedViaInfo(page, () => page.locator('.nav-links a', { hasText: 'Map' }).click());
});

test('menu map link preserves map camera from info page', async ({ page }) => {
  await assertMapPreservedViaInfo(page, async () => {
    await page.locator('.menu-btn-trigger').click();
    await expect(page.locator('.menu')).toBeVisible();
    await page.locator('.menu-links a', { hasText: 'Map' }).click();
  });
});
