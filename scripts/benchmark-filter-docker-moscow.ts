/* global document, location, window */

const { chromium } = require('playwright');

const TARGET_URL = process.env.BENCHMARK_URL
  || 'http://127.0.0.1:3252/?lat=55.753115&lng=37.629365&z=13.41&f=AgEPYnVpbGRpbmc6bGV2ZWxzBgKG76wBAAEBMQL94EcBAAEBMgL9unQCAAcBMwAIATUC-5I8AgAHATUACAE5AvhxcQIABwE5AAgCMTYCwIT8AQAHAjE2';
const VIEWPORT = { width: 1440, height: 900 };
const SAMPLES = Math.max(1, Number(process.env.BENCHMARK_SAMPLES || 5));

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const avg = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    min: Math.round(sorted[0] || 0),
    p50: Math.round(sorted[Math.floor(sorted.length / 2)] || 0),
    max: Math.round(sorted[sorted.length - 1] || 0),
    avg: Math.round(avg),
    samples: values.map((value) => Math.round(value))
  };
}

async function waitForAuthoritative(page, previousRequestStarts, {
  expectRequest = false,
  allowCacheHit = false
} = {}) {
  await page.waitForFunction(({ requestStarts, expectRequestFlag, allowCacheHitFlag }) => {
    const el = document.querySelector('.map-canvas') as HTMLElement | null;
    const phase = String(el?.dataset?.filterPhase || '');
    const count = Number(el?.dataset?.filterLastCount || 0);
    const starts = Number((window.__MAP_DEBUG__?.filterRequests || {}).start || 0);
    const cacheHit = String(el?.dataset?.filterCacheHit || '') === 'true';
    if (phase !== 'authoritative' || count <= 0) return false;
    if (!expectRequestFlag) return true;
    return starts > requestStarts || (allowCacheHitFlag && cacheHit);
  }, {
    requestStarts: Number(previousRequestStarts || 0),
    expectRequestFlag: Boolean(expectRequest),
    allowCacheHitFlag: Boolean(allowCacheHit)
  }, {
    timeout: 120000
  });
  await page.waitForTimeout(900);
}

async function readSnapshot(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.map-canvas') as HTMLElement | null;
    const requests = window.__MAP_DEBUG__?.filterRequests || {};
    const mode = String(el?.dataset?.filterHighlightMode || '');
    return {
      url: String(location.search || ''),
      phase: String(el?.dataset?.filterPhase || ''),
      active: String(el?.dataset?.filterActive || ''),
      count: Number(el?.dataset?.filterLastCount || 0),
      elapsedMs: Number(el?.dataset?.filterLastElapsedMs || 0),
      applyMs: mode === 'paint-property'
        ? Number(el?.dataset?.filterLastPaintApplyMs || 0)
        : Number(el?.dataset?.filterLastApplyDiffMs || 0),
      applyCalls: mode === 'paint-property'
        ? Number(el?.dataset?.filterSetPaintPropertyCalls || 0)
        : Number(el?.dataset?.filterSetFeatureStateCalls || 0),
      cacheHit: String(el?.dataset?.filterCacheHit || ''),
      mode,
      requestStarts: Number(requests.start || 0),
      requestFinishes: Number(requests.finish || 0)
    };
  });
}

async function dragMap(page, sourceX, targetX, y = 430) {
  const canvas = page.locator('.maplibregl-canvas');
  await canvas.dragTo(canvas, {
    sourcePosition: { x: sourceX, y },
    targetPosition: { x: targetX, y }
  });
}

async function runSample(browser, sampleIndex) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  try {
    const initialStartedAt = Date.now();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitForAuthoritative(page, 0, { expectRequest: false });
    const initialTransitionMs = Date.now() - initialStartedAt;

    const initial = await readSnapshot(page);
    initial.transitionMs = initialTransitionMs;

    const beforeSmallPan = await readSnapshot(page);
    const smallPanStartedAt = Date.now();
    await dragMap(page, 720, 820);
    await waitForAuthoritative(page, beforeSmallPan.requestStarts, { expectRequest: false });
    const smallPan = await readSnapshot(page);
    smallPan.transitionMs = Date.now() - smallPanStartedAt;

    const beforeLargePanRight = await readSnapshot(page);
    const largePanRightStartedAt = Date.now();
    await dragMap(page, 620, 1120);
    await waitForAuthoritative(page, beforeLargePanRight.requestStarts, { expectRequest: true });
    const largePanRight = await readSnapshot(page);
    largePanRight.transitionMs = Date.now() - largePanRightStartedAt;

    const beforeLargePanLeft = await readSnapshot(page);
    const largePanLeftStartedAt = Date.now();
    await dragMap(page, 820, 320);
    await waitForAuthoritative(page, beforeLargePanLeft.requestStarts, {
      expectRequest: true,
      allowCacheHit: true
    });
    const largePanLeft = await readSnapshot(page);
    largePanLeft.transitionMs = Date.now() - largePanLeftStartedAt;

    const result = {
      sampleIndex,
      initial,
      smallPan: {
        ...smallPan,
        requestDelta: smallPan.requestStarts - beforeSmallPan.requestStarts,
        applyDelta: smallPan.applyMs - beforeSmallPan.applyMs
      },
      largePanRight: {
        ...largePanRight,
        requestDelta: largePanRight.requestStarts - beforeLargePanRight.requestStarts,
        applyDelta: largePanRight.applyMs - beforeLargePanRight.applyMs
      },
      largePanLeft: {
        ...largePanLeft,
        requestDelta: largePanLeft.requestStarts - beforeLargePanLeft.requestStarts,
        applyDelta: largePanLeft.applyMs - beforeLargePanLeft.applyMs
      }
    };

    console.error(`sample ${sampleIndex + 1}: ${JSON.stringify(result)}`);
    return result;
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const results = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      results.push(await runSample(browser, index));
    }

    const report = {
      targetUrl: TARGET_URL,
      samples: SAMPLES,
      mode: results[0]?.initial?.mode || 'unknown',
      initialTransitionMs: summarize(results.map((entry) => entry.initial.transitionMs)),
      initialElapsedMs: summarize(results.map((entry) => entry.initial.elapsedMs)),
      initialApplyMs: summarize(results.map((entry) => entry.initial.applyMs)),
      initialApplyCalls: summarize(results.map((entry) => entry.initial.applyCalls)),
      smallPanTransitionMs: summarize(results.map((entry) => entry.smallPan.transitionMs)),
      smallPanRequestDelta: summarize(results.map((entry) => entry.smallPan.requestDelta)),
      smallPanApplyMs: summarize(results.map((entry) => entry.smallPan.applyMs)),
      smallPanApplyCalls: summarize(results.map((entry) => entry.smallPan.applyCalls)),
      largePanRightTransitionMs: summarize(results.map((entry) => entry.largePanRight.transitionMs)),
      largePanRightElapsedMs: summarize(results.map((entry) => entry.largePanRight.elapsedMs)),
      largePanRightApplyMs: summarize(results.map((entry) => entry.largePanRight.applyMs)),
      largePanRightApplyCalls: summarize(results.map((entry) => entry.largePanRight.applyCalls)),
      largePanRightRequestDelta: summarize(results.map((entry) => entry.largePanRight.requestDelta)),
      largePanLeftTransitionMs: summarize(results.map((entry) => entry.largePanLeft.transitionMs)),
      largePanLeftElapsedMs: summarize(results.map((entry) => entry.largePanLeft.elapsedMs)),
      largePanLeftApplyMs: summarize(results.map((entry) => entry.largePanLeft.applyMs)),
      largePanLeftApplyCalls: summarize(results.map((entry) => entry.largePanLeft.applyCalls)),
      largePanLeftRequestDelta: summarize(results.map((entry) => entry.largePanLeft.requestDelta)),
      raw: results
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
