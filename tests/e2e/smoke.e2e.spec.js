const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { test, expect } = require('@playwright/test');

const PORT = 4020 + Math.floor(Math.random() * 120);
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-e2e-'));

  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      METRICS_ENABLED: 'false',
      AUTO_SYNC_ENABLED: 'false',
      AUTO_SYNC_ON_START: 'false',
      SESSION_ALLOW_MEMORY_FALLBACK: 'true',
      SESSION_SECRET: 'e2e-secret-value',
      APP_BASE_URL: BASE_URL,
      ARCHIMAP_DB_PATH: path.join(tmpRoot, 'archimap.db'),
      LOCAL_EDITS_DB_PATH: path.join(tmpRoot, 'local-edits.db'),
      USER_EDITS_DB_PATH: path.join(tmpRoot, 'user-edits.db'),
      USER_AUTH_DB_PATH: path.join(tmpRoot, 'users.db'),
      BUILDINGS_PMTILES_FILE: 'buildings.pmtiles'
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

test('opens home page and initializes map without runtime JS errors', async ({ page }) => {
  const runtimeErrors = [];
  page.on('pageerror', (error) => {
    runtimeErrors.push(String(error?.message || error));
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text === 'nr') return;
    if (/Failed to load resource|ERR_BLOCKED_BY_CLIENT/i.test(text)) return;
    runtimeErrors.push(text);
  });

  await page.goto(`${BASE_URL}/app`, { waitUntil: 'networkidle' });
  await expect(page.locator('.map-canvas')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.maplibregl-canvas')).toBeVisible({ timeout: 15000 });

  // Modal opening is optional in smoke mode and depends on fixture data.
  await page.locator('.map-canvas').click({ position: { x: 320, y: 260 } });
  const modal = page.locator('#building-modal');
  if (await modal.isVisible({ timeout: 1000 }).catch(() => false)) {
    await expect(modal).toBeVisible();
  }

  expect(runtimeErrors).toEqual([]);
});

test('opens legal info deep link on terms tab', async ({ page }) => {
  await page.goto(`${BASE_URL}/app/info?tab=legal&doc=terms`, { waitUntil: 'networkidle' });
  await expect(page.locator('h2', { hasText: 'Пользовательское соглашение' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.legal-markdown')).toBeVisible({ timeout: 15000 });
});

test('keeps map deep link params and renders map', async ({ page }) => {
  await page.goto(`${BASE_URL}/app?lat=40.7128&lng=-74.006&z=13.25`, { waitUntil: 'networkidle' });
  await expect(page.locator('.maplibregl-canvas')).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(/lat=40\.7128/);
  await expect(page).toHaveURL(/lng=-74\.006/);
  await expect(page).toHaveURL(/z=13\.25/);
});
