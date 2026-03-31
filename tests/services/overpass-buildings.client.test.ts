const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadOverpassBuildings() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'overpass-buildings.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${importCounter += 1}`);
}

function toRequestUrl(input: RequestInfo | URL) {
  if (input instanceof URL) {
    return input;
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return new URL(input.url);
  }
  return new URL(String(input));
}

function isExactEndpointMatch(actual: URL, expected: string) {
  const target = new URL(expected);
  return actual.origin === target.origin
    && actual.pathname === target.pathname
    && actual.search === target.search;
}

function readStoreValue(store) {
  let value;
  const unsubscribe = store.subscribe((next) => {
    value = next;
  });
  unsubscribe();
  return value;
}

async function waitFor(predicate, timeoutMs = 2000, intervalMs = 10) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('overpass coverage checks stay disabled until zoom 12', async () => {
  const {
    OVERPASS_MIN_COVERAGE_CHECK_ZOOM,
    shouldCheckOverpassViewportCoverage
  } = await loadOverpassBuildings();

  assert.equal(OVERPASS_MIN_COVERAGE_CHECK_ZOOM, 12);
  assert.equal(shouldCheckOverpassViewportCoverage(null), false);
  assert.equal(shouldCheckOverpassViewportCoverage(11.99), false);
  assert.equal(shouldCheckOverpassViewportCoverage(12), true);
  assert.equal(shouldCheckOverpassViewportCoverage(14), true);
});

test('camera movement does not abort or restart an active Overpass load', async () => {
  const previousFetch = global.fetch;
  const fetchCalls = [];
  const pendingTileResponses = [];
  let releaseTileResponses = false;
  let tileFetchSignal = null;

  const mockFetch: typeof fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = String(init.body || '');
    if (body.includes('node(1);out ids;')) {
      fetchCalls.push({ kind: 'probe', input, init });
      return new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    fetchCalls.push({ kind: 'tile', input, init });
    tileFetchSignal = init.signal || null;
    const createTileResponse = () => new Response(JSON.stringify({ elements: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
    if (releaseTileResponses) {
      return createTileResponse();
    }
    return await new Promise<Response>((resolve) => {
      pendingTileResponses.push(() => resolve(createTileResponse()));
    });
  };
  global.fetch = mockFetch;

  function releasePendingTileResponses() {
    releaseTileResponses = true;
    while (pendingTileResponses.length > 0) {
      const resolve = pendingTileResponses.shift();
      resolve?.();
    }
  }

  try {
    const { overpassBuildingsState, requestOverpassViewportLoad, scheduleOverpassViewportRefresh } = await loadOverpassBuildings();
    const initialViewport = {
      west: 37.5,
      south: 55.7,
      east: 37.51,
      north: 55.71
    };
    const movedViewport = {
      west: 37.52,
      south: 55.7,
      east: 37.53,
      north: 55.71
    };

    const loadPromise = requestOverpassViewportLoad({
      viewport: initialViewport,
      zoom: 14,
      covered: false
    });

    await waitFor(() => fetchCalls.some((entry) => entry.kind === 'tile'));

    const fetchCountBeforeMove = fetchCalls.length;
    assert.equal(readStoreValue(overpassBuildingsState).loading, true);

    scheduleOverpassViewportRefresh({
      viewport: movedViewport,
      zoom: 14,
      covered: false
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(fetchCalls.length, fetchCountBeforeMove);
    assert.equal(tileFetchSignal?.aborted, false);
    assert.equal(readStoreValue(overpassBuildingsState).loading, true);

    releasePendingTileResponses();
    await loadPromise;

    assert.equal(readStoreValue(overpassBuildingsState).loading, false);
  } finally {
    global.fetch = previousFetch;
  }
});

test('overpass load keeps multiple tile requests in flight when only one endpoint is healthy', async () => {
  const previousFetch = global.fetch;
  const tileEndpoints: URL[] = [];
  const pendingTileResponses: Array<() => void> = [];
  let releaseTileResponses = false;
  let phase: 'warmup' | 'parallel' = 'warmup';
  let activeTileRequests = 0;
  let maxConcurrentTileRequests = 0;
  const healthyEndpoint = 'https://overpass.kumi.systems/api/interpreter';

  const mockFetch: typeof fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const endpoint = toRequestUrl(input);
    const body = String(init.body || '');
    if (body.includes('node(1);out ids;')) {
      return new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    tileEndpoints.push(endpoint);
    if (phase === 'warmup') {
      if (isExactEndpointMatch(endpoint, healthyEndpoint)) {
        return new Response(JSON.stringify({ elements: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response('Gateway Timeout', {
        status: 504,
        headers: { 'content-type': 'text/plain' }
      });
    }

    if (isExactEndpointMatch(endpoint, healthyEndpoint)) {
      activeTileRequests += 1;
      maxConcurrentTileRequests = Math.max(maxConcurrentTileRequests, activeTileRequests);
      const createTileResponse = () => new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
      if (releaseTileResponses) {
        activeTileRequests -= 1;
        return createTileResponse();
      }
      return await new Promise<Response>((resolve) => {
        pendingTileResponses.push(() => {
          activeTileRequests -= 1;
          resolve(createTileResponse());
        });
      });
    }

    return new Response('Gateway Timeout', {
      status: 504,
      headers: { 'content-type': 'text/plain' }
    });
  };
  global.fetch = mockFetch;

  try {
    const { refreshOverpassViewportData, requestOverpassViewportLoad } = await loadOverpassBuildings();
    const viewport = {
      west: 37.5,
      south: 55.7,
      east: 37.52,
      north: 55.72
    };

    await requestOverpassViewportLoad({
      viewport,
      zoom: 14,
      covered: false
    });

    phase = 'parallel';

    const refreshPromise = refreshOverpassViewportData({
      viewport,
      zoom: 14,
      covered: false
    });

    await waitFor(() => maxConcurrentTileRequests >= 2);
    assert.ok(tileEndpoints.some((endpoint) => isExactEndpointMatch(endpoint, healthyEndpoint)));
    assert.ok(maxConcurrentTileRequests >= 2);

    releaseTileResponses = true;
    while (pendingTileResponses.length > 0) {
      const resolve = pendingTileResponses.shift();
      resolve?.();
    }
    await refreshPromise;

    assert.ok(tileEndpoints.filter((endpoint) => isExactEndpointMatch(endpoint, healthyEndpoint)).length >= 2);
  } finally {
    global.fetch = previousFetch;
  }
});

test('overpass endpoint cooldown skips repeated 504 failures and ignores mail.ru', async () => {
  const previousFetch = global.fetch;
  const tileEndpoints: URL[] = [];
  const primaryEndpoint = 'https://overpass-api.de/api/interpreter';
  const mailRuEndpoint = 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';

  const mockFetch: typeof fetch = async (input: RequestInfo | URL) => {
    const endpoint = toRequestUrl(input);
    tileEndpoints.push(endpoint);

    if (isExactEndpointMatch(endpoint, primaryEndpoint)) {
      return new Response('Gateway Timeout', {
        status: 504,
        headers: { 'content-type': 'text/plain' }
      });
    }

    return new Response(JSON.stringify({ elements: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  global.fetch = mockFetch;

  try {
    const { refreshOverpassViewportData, requestOverpassViewportLoad } = await loadOverpassBuildings();
    const viewport = {
      west: 37.5,
      south: 55.7,
      east: 37.52,
      north: 55.72
    };

    await requestOverpassViewportLoad({
      viewport,
      zoom: 14,
      covered: false
    });

    const primaryEndpointCallsBeforeRefresh = tileEndpoints.filter((endpoint) => isExactEndpointMatch(endpoint, primaryEndpoint)).length;
    const mailRuCallsBeforeRefresh = tileEndpoints.filter((endpoint) => isExactEndpointMatch(endpoint, mailRuEndpoint)).length;

    assert.ok(primaryEndpointCallsBeforeRefresh > 0);
    assert.equal(mailRuCallsBeforeRefresh, 0);

    await refreshOverpassViewportData({
      viewport,
      zoom: 14,
      covered: false
    });

    const primaryEndpointCallsAfterRefresh = tileEndpoints.filter((endpoint) => isExactEndpointMatch(endpoint, primaryEndpoint)).length;
    const mailRuCallsAfterRefresh = tileEndpoints.filter((endpoint) => isExactEndpointMatch(endpoint, mailRuEndpoint)).length;

    assert.equal(primaryEndpointCallsAfterRefresh, primaryEndpointCallsBeforeRefresh);
    assert.equal(mailRuCallsAfterRefresh, 0);
  } finally {
    global.fetch = previousFetch;
  }
});
