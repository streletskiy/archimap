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
      BUILDINGS_PMTILES_FILE: 'buildings.pmtiles',
      MAP_SELECTION_ATOMIC_DEBUG: 'true'
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
  const shouldIgnoreRuntimeError = (text) => {
    const message = String(text || '');
    return /Bad response code: 404|Wrong magic number for PMTiles archive|Failed to load resource|ERR_BLOCKED_BY_CLIENT/i.test(message);
  };
  page.on('pageerror', (error) => {
    const text = String(error?.message || error);
    if (shouldIgnoreRuntimeError(text)) return;
    runtimeErrors.push(text);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text === 'nr') return;
    if (shouldIgnoreRuntimeError(text)) return;
    runtimeErrors.push(text);
  });

  await page.goto(`${BASE_URL}/app`, { waitUntil: 'domcontentloaded' });
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
  await page.goto(`${BASE_URL}/app/info?tab=legal&doc=terms`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.legal-markdown h1', { hasText: 'Пользовательское соглашение archimap' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.legal-markdown')).toBeVisible({ timeout: 15000 });
});

test('language switch updates visible UI content', async ({ page }) => {
  await page.goto(`${BASE_URL}/app`, { waitUntil: 'domcontentloaded' });
  await page.locator('.menu-btn-trigger').click();
  await page.locator('.locale-select').selectOption('en');
  await expect(page.locator('.menu .menu-btn', { hasText: 'Sign in' })).toBeVisible({ timeout: 10000 });
});

test('keeps map deep link params and renders map', async ({ page }) => {
  await page.goto(`${BASE_URL}/app?lat=40.7128&lng=-74.006&z=13.25`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.maplibregl-canvas')).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(/[?&]lat=/);
  await expect(page).toHaveURL(/[?&]lng=/);
  await expect(page).toHaveURL(/[?&]z=/);
});

test('building filter uses highlight layers and does not apply setFilter to base building layers', async ({ page }) => {
  await page.goto(`${BASE_URL}/app?building=way/1`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.map-canvas')).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => page.evaluate(() => globalThis.document.body.dataset.selectedBuildingId || '')).toBe('way/1');

  await page.locator('header .left .icon-btn').first().click();
  await expect(page.locator('.filter-panel')).toBeVisible({ timeout: 5000 });

  await page.locator('.filter-panel .row input[list="filter-tag-keys"]').first().fill('name');
  await page.locator('.filter-panel .row input.ui-field.ui-field-xs').nth(1).fill('test');
  await page.locator('.filter-panel .filter-actions .ui-btn-primary').click();

  await expect.poll(async () => page.evaluate(() => globalThis.document.querySelector('.map-canvas')?.getAttribute('data-filter-highlight-mode') || '')).toBe('feature-state');
  await expect.poll(async () => page.evaluate(() => globalThis.document.querySelector('.map-canvas')?.getAttribute('data-filter-phase') || '')).toBe('authoritative');
  await expect.poll(async () => page.evaluate(() => {
    const debug = globalThis.window.__MAP_DEBUG__ || {};
    const history = Array.isArray(debug.filterPhaseHistory) ? debug.filterPhaseHistory : [];
    return history.includes('optimistic') && history.includes('authoritative');
  })).toBe(true);
  await expect.poll(async () => page.evaluate(() => globalThis.document.body.dataset.selectedBuildingId || '')).toBe('way/1');

  const setFilterLayers = await page.evaluate(() => {
    const debug = globalThis.window.__MAP_DEBUG__ || {};
    return Array.isArray(debug.setFilterLayers) ? debug.setFilterLayers : [];
  });
  expect(setFilterLayers).not.toContain('local-buildings-fill');
  expect(setFilterLayers).not.toContain('local-buildings-line');
});

test('building filter handles fast rule updates and reaches authoritative state', async ({ page }) => {
  await page.goto(`${BASE_URL}/app`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.map-canvas')).toBeVisible({ timeout: 15000 });
  await page.locator('header .left .icon-btn').first().click();
  await expect(page.locator('.filter-panel')).toBeVisible({ timeout: 5000 });

  const keyInput = page.locator('.filter-panel .row input[list="filter-tag-keys"]').first();
  const valueInput = page.locator('.filter-panel .row input.ui-field.ui-field-xs').nth(1);
  const applyBtn = page.locator('.filter-panel .filter-actions .ui-btn-primary');

  await keyInput.fill('name');
  await valueInput.fill('first');
  await applyBtn.click();
  await page.waitForTimeout(140);
  await valueInput.fill('second');
  await applyBtn.click();

  await expect.poll(async () => page.evaluate(() => {
    const stats = (globalThis.window.__MAP_DEBUG__ || {}).filterRequests || {};
    return Number(stats.start || 0);
  })).toBeGreaterThan(0);
  await expect.poll(async () => page.evaluate(() => {
    const stats = (globalThis.window.__MAP_DEBUG__ || {}).filterRequests || {};
    return Number(stats.finish || 0);
  })).toBeGreaterThan(0);
  await expect.poll(async () => page.evaluate(() => globalThis.document.querySelector('.map-canvas')?.getAttribute('data-filter-phase') || '')).toBe('authoritative');
});

test('pan/zoom updates filter without request spam', async ({ page }) => {
  await page.goto(`${BASE_URL}/app`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.map-canvas')).toBeVisible({ timeout: 15000 });
  await page.locator('header .left .icon-btn').first().click();
  await expect(page.locator('.filter-panel')).toBeVisible({ timeout: 5000 });
  await page.locator('.filter-panel .row input[list="filter-tag-keys"]').first().fill('name');
  await page.locator('.filter-panel .row input.ui-field.ui-field-xs').nth(1).fill('a');
  await page.locator('.filter-panel .filter-actions .ui-btn-primary').click();
  await expect.poll(async () => page.evaluate(() => globalThis.document.querySelector('.map-canvas')?.getAttribute('data-filter-phase') || '')).toBe('authoritative');

  const baseline = await page.evaluate(() => {
    const debug = globalThis.window.__MAP_DEBUG__ || {};
    const req = debug.filterRequests || {};
    const telemetry = debug.filterTelemetry || {};
    return {
      start: Number(req.start || 0),
      cleared: Number((telemetry.counters || {}).filter_state_cleared || 0)
    };
  });

  const canvas = page.locator('.maplibregl-canvas');
  await canvas.hover({ position: { x: 420, y: 320 } });
  await page.mouse.down();
  await page.mouse.move(280, 320, { steps: 8 });
  await page.mouse.move(520, 310, { steps: 8 });
  await page.mouse.move(360, 300, { steps: 8 });
  await page.mouse.up();

  await page.mouse.wheel(0, -1200);
  await page.mouse.wheel(0, 1200);
  await page.keyboard.press('=');
  await page.keyboard.press('-');

  await expect.poll(async () => page.evaluate(() => globalThis.document.querySelector('.map-canvas')?.getAttribute('data-filter-phase') || '')).not.toBe('idle');
  await expect.poll(async () => page.evaluate(() => {
    const debug = globalThis.window.__MAP_DEBUG__ || {};
    const stats = debug.filterRequests || {};
    return Number(stats.start || 0);
  })).toBeLessThan(14);

  await expect.poll(async () => page.evaluate((snapshot) => {
    const debug = globalThis.window.__MAP_DEBUG__ || {};
    const req = debug.filterRequests || {};
    return Number(req.start || 0) - Number(snapshot.start || 0);
  }, baseline)).toBeLessThan(7);

  await expect.poll(async () => page.evaluate((snapshot) => {
    const debug = globalThis.window.__MAP_DEBUG__ || {};
    const telemetry = debug.filterTelemetry || {};
    return Number((telemetry.counters || {}).filter_state_cleared || 0) - Number(snapshot.cleared || 0);
  }, baseline)).toBeLessThan(1);

  await expect.poll(async () => page.evaluate(() => {
    const debug = globalThis.window.__MAP_DEBUG__ || {};
    const events = Array.isArray((debug.filterTelemetry || {}).recentEvents) ? debug.filterTelemetry.recentEvents : [];
    const delays = events
      .filter((item) => item?.event === 'apply_plan_finish' && Number.isFinite(Number(item?.delayFromMoveEndMs)))
      .map((item) => Number(item.delayFromMoveEndMs))
      .sort((a, b) => a - b);
    if (delays.length === 0) return 0;
    const idx = Math.min(delays.length - 1, Math.floor(delays.length * 0.95));
    return delays[idx];
  })).toBeLessThan(2200);
});
