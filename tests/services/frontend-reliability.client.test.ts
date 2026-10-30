const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const load = (file) => import(pathToFileURL(path.join(process.cwd(), 'frontend/src/lib', file)).href);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('failed logout keeps the authenticated session until the server confirms success', async (t) => {
  const { get } = await import('svelte/store');
  const { setSession, session } = await load('stores/auth.ts');
  const { logoutSession } = await load('services/auth-session.ts');
  setSession({ authenticated: true, user: { id: 1 }, csrfToken: 'test' });
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => json({}, ++attempts === 1 ? 503 : 200));
  await assert.rejects(logoutSession());
  assert.equal((get(session) as any).authenticated, true);
  await logoutSession();
  assert.equal((get(session) as any).authenticated, false);
});

test('HTTP cached results are invalidated by account and building edit changes', async (t) => {
  const { setSession, clearSession } = await load('stores/auth.ts');
  const { invalidateBuildingData } = await load('stores/building-data.ts');
  const { apiJsonCached } = await load('services/http.ts');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => json({ request: ++requests }));
  t.after(clearSession);
  setSession({ authenticated: true, user: { id: 1 } });
  assert.equal((await apiJsonCached('/api/audit-cache', { ttlMs: 60_000 })).request, 1);
  assert.equal((await apiJsonCached('/api/audit-cache', { ttlMs: 60_000 })).request, 1);
  setSession({ authenticated: true, user: { id: 2 } });
  assert.equal((await apiJsonCached('/api/audit-cache', { ttlMs: 60_000 })).request, 2);
  invalidateBuildingData();
  assert.equal((await apiJsonCached('/api/audit-cache', { ttlMs: 60_000 })).request, 3);
});

test('data revisions revalidate fresh browser cache while preserving shared dictionary caches', async (t) => {
  const { apiJson, apiJsonCached } = await load('services/http.ts');
  const { invalidateBuildingData } = await load('stores/building-data.ts');
  const requests = [];
  let serverValue = 1;
  let browserCachedValue = 1;
  t.mock.method(globalThis, 'fetch', async (url, init: RequestInit = {}) => {
    requests.push({ url: String(url), cache: init.cache });
    if (init.cache === 'no-cache') browserCachedValue = serverValue;
    return json({ value: browserCachedValue });
  });
  const dictionary = '/api/filter-presets?audit=revision';
  await apiJsonCached(dictionary, { ttlMs: 60_000 });
  const search = '/api/search-buildings?q=browser-cache-revision';
  assert.equal((await apiJsonCached(search, { ttlMs: 60_000 })).value, 1);
  serverValue = 2;
  invalidateBuildingData();
  assert.equal((await apiJsonCached(search, { ttlMs: 60_000 })).value, 2);
  await apiJsonCached(dictionary, { ttlMs: 60_000 });
  assert.equal(requests.filter((request) => request.url === dictionary).length, 1);
  assert.equal(requests.find((request) => request.url === dictionary).cache, undefined);
  await apiJson('/api/building-info/way/123');
  assert.equal(requests.at(-1).cache, 'no-cache');
  await apiJson('/api/filter-tag-keys?audit=revision');
  assert.equal(requests.at(-1).cache, undefined);
  await apiJson('/api/building-info/way/456', { cache: 'no-store' });
  assert.equal(requests.at(-1).cache, 'no-store');
});

test('active search discards an old account response and reloads after data changes', async (t) => {
  const { get } = await import('svelte/store');
  const search = await load('stores/search.ts');
  const { invalidateBuildingData } = await load('stores/building-data.ts');
  const { createSearchManager } = await load('services/search-manager.ts');
  search.resetSearchState();
  search.searchCommand.set(null);
  let finishOld;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1)
      return new Promise<Response>((resolve) => {
        finishOld = resolve;
      });
    return json({ items: [{ osmType: 'way', osmId: 2 }], total: 1 });
  });
  const manager = createSearchManager();
  manager.start();
  t.after(() => {
    manager.destroy();
    search.resetSearchState();
    search.searchCommand.set(null);
  });
  search.requestSearch({ query: 'revision audit' });
  await flush();
  invalidateBuildingData();
  for (let i = 0; i < 4; i += 1) await flush();
  assert.equal((get(search.searchState) as any).items[0].osmId, 2);
  finishOld(json({ items: [{ osmType: 'way', osmId: 1 }], total: 1 }));
  for (let i = 0; i < 4; i += 1) await flush();
  assert.equal((get(search.searchState) as any).items[0].osmId, 2);
});

async function detailsFixture(t, postHandler: (body: any) => Response = () => json({ editId: 1, status: 'pending' })) {
  const { setSession, clearSession } = await load('stores/auth.ts');
  const { clearSelectedBuildings } = await load('stores/map.ts');
  const { createBuildingDetailsManager } = await load('services/building-details-manager.ts');
  clearSelectedBuildings();
  setSession({ authenticated: true, user: { id: 1 }, csrfToken: 'test' });
  const requests = [];
  let inFlight = 0;
  let peak = 0;
  t.mock.method(globalThis, 'fetch', async (url, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url: String(url), body });
    if (init.method === 'POST') return postHandler(body);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await flush();
    inFlight -= 1;
    if (String(url).includes('/building-info/')) return json({ levels: '1' });
    return json({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [44, 56],
            [44.1, 56],
            [44, 56.1],
            [44, 56]
          ]
        ]
      },
      properties: { source_tags: { building: 'yes', 'building:levels': '1' } }
    });
  });
  const manager = createBuildingDetailsManager();
  let state;
  const stop = manager.subscribe((value) => {
    state = value;
  });
  t.after(() => {
    manager.destroy();
    stop();
    clearSelectedBuildings();
    clearSession();
  });
  async function select(id, shiftKey = false) {
    manager.selectBuilding({ osmType: 'way', osmId: id, shiftKey });
    for (let i = 0; i < 5; i += 1) await flush();
  }
  return {
    manager,
    requests,
    select,
    get state() {
      return state;
    },
    get peak() {
      return peak;
    }
  };
}

test('adding to bulk selection fetches only the newly selected building', async (t) => {
  const fixture = await detailsFixture(t);
  await fixture.select(1);
  await fixture.select(2, true);
  await fixture.select(3, true);
  assert.equal(fixture.requests.length, 6);
  assert.equal(fixture.state.selectedBuildingDetails.length, 3);
  await fixture.select(2, true);
  assert.equal(fixture.requests.length, 6);
});

test('selecting 50 buildings makes 100 detail requests instead of refetching earlier selections', async (t) => {
  const fixture = await detailsFixture(t);
  for (let id = 1; id <= 50; id += 1) await fixture.select(id, id > 1);
  assert.equal(fixture.requests.length, 100);
  assert.equal(fixture.state.selectedBuildingDetails.length, 50);
  assert.ok(fixture.peak <= 4);
});

test('bulk detail requests stay bounded and clearing cannot restore a late selection', async (t) => {
  const fixture = await detailsFixture(t);
  for (let i = 1; i <= 15; i += 1) fixture.manager.selectBuilding({ osmType: 'way', osmId: i, shiftKey: i > 1 });
  for (let i = 0; i < 40; i += 1) await flush();
  assert.ok(fixture.peak <= 4);
  assert.equal(fixture.state.selectedBuildingDetails.length, 15);
  fixture.manager.selectBuilding({ osmType: 'way', osmId: 999 });
  fixture.manager.clearSelection();
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(fixture.state.buildingDetails, null);
  assert.equal(fixture.state.selectedBuildingIdentity, null);
});

test('partial bulk save keeps per-object edit IDs and retries only failed objects', async (t) => {
  let failSecond = true;
  const fixture = await detailsFixture(t, (body) =>
    body.osmId === 2 && failSecond ? json({}, 500) : json({ editId: 100 + body.osmId, status: 'pending' })
  );
  await fixture.select(1);
  await fixture.select(2, true);
  await fixture.select(3, true);
  const edit = { osmType: 'way', osmId: 1, levels: '5', editedFields: ['levels'] };
  await fixture.manager.saveEdit(edit);
  assert.deepEqual(
    fixture.state.selectedBuildingDetails.map((item) => item.user_edit_id),
    [101, null, 103]
  );
  assert.deepEqual(
    fixture.state.selectedBuildingDetails.map((item) => item.properties.archiInfo.levels),
    ['5', '1', '5']
  );
  assert.match(fixture.state.saveStatus, /2/);
  assert.match(fixture.state.saveStatus, /1/);
  failSecond = false;
  await fixture.manager.saveEdit(edit);
  assert.deepEqual(
    fixture.requests.filter((item) => item.body).map((item) => item.body.osmId),
    [1, 2, 3, 2]
  );
});

test('switching accounts during a bulk save stops remaining writes and discards old edit metadata', async (t) => {
  const { setSession } = await load('stores/auth.ts');
  const fixture = await detailsFixture(t, () => {
    setSession({ authenticated: true, user: { id: 2 }, csrfToken: 'second-account' });
    return json({ editId: 777, status: 'pending' });
  });
  await fixture.select(1);
  await fixture.select(2, true);
  await fixture.manager.saveEdit({ osmType: 'way', osmId: 1, levels: '5', editedFields: ['levels'] });
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(fixture.requests.filter((item) => item.body).length, 1);
  assert.ok(fixture.state.selectedBuildingDetails.every((item) => item.user_edit_id !== 777));
  assert.equal(fixture.state.savePending, false);
});

test('Overpass cache budgets evict least recently used records and reject stale timestamps', async () => {
  const { selectOverpassCacheEvictions, isOverpassTileFresh, OVERPASS_TILE_TTL_MS } = await load(
    'services/map/overpass-cache-policy.ts'
  );
  const records = [
    { key: 'old', bytes: 70, touchedAt: 1 },
    { key: 'new', bytes: 70, touchedAt: 3 },
    { key: 'middle', bytes: 20, touchedAt: 2 }
  ];
  assert.deepEqual(selectOverpassCacheEvictions(records, 2, 100), ['old']);
  assert.deepEqual(selectOverpassCacheEvictions(records, 3, 50), ['old', 'middle', 'new']);
  const now = OVERPASS_TILE_TTL_MS * 2;
  assert.equal(isOverpassTileFresh({ fetchedAt: now - 100 }, now), true);
  assert.equal(isOverpassTileFresh({ fetchedAt: now - OVERPASS_TILE_TTL_MS }, now), false);
  assert.equal(isOverpassTileFresh({ fetchedAt: now + 1 }, now), false);
});

test('style request parameters preserve all canonical keys and the next-page cursor', async () => {
  const { buildSearchRequestParams } = await load('services/search-params.ts');
  const keys = Array.from({ length: 8 }, (_, index) => `style-${index}`);
  const params = buildSearchRequestParams({ query: 'style', styleKeys: keys, limit: 120, cursor: 120 });
  assert.deepEqual(JSON.parse(params.get('styleKeys')), keys);
  assert.equal(params.get('cursor'), '120');
});

test('floor preview expressions compile, preserve priority and exclude legacy tiles', async () => {
  const { createExpression } = require('../../frontend/node_modules/@maplibre/maplibre-gl-style-spec');
  const { prepareFilterRequestPlan } = await load('services/map/filter-request-planner.ts');
  const { buildFloorPreviewExpressions, applyFloorPreview } = await load('services/map/filter-floor-preview.ts');
  const plan = prepareFilterRequestPlan([
    {
      id: 'low',
      priority: 0,
      color: '#ff0000',
      mode: 'layer',
      rules: [{ key: 'building:levels', op: 'equals', value: '1' }]
    },
    {
      id: 'tall',
      priority: 1,
      color: '#00ff00',
      mode: 'layer',
      rules: [{ key: 'building:levels', op: 'greater_or_equals', value: '5' }]
    }
  ]);
  const preview = buildFloorPreviewExpressions(plan);
  const filter = createExpression(preview.filter, { type: 'boolean' });
  const color = createExpression(preview.color, { type: 'color' });
  assert.equal(filter.result, 'success');
  assert.equal(color.result, 'success');
  const evaluate = (properties) => filter.value.evaluate({ zoom: 14 }, { type: 'Polygon', properties });
  assert.equal(evaluate({ filter_schema: 1, filter_levels: '1', filter_levels_num: 1 }), true);
  assert.equal(evaluate({ filter_schema: 1, filter_levels: '7', filter_levels_num: 7 }), true);
  assert.equal(evaluate({ filter_schema: 1, filter_levels: '2', filter_levels_num: 2 }), false);
  assert.equal(evaluate({ filter_levels: '7', filter_levels_num: 7 }), false);
  assert.equal(evaluate({ filter_schema: 1, filter_levels: '' }), false);
  assert.equal(evaluate({ filter_schema: 1, filter_levels: 'unknown', filter_levels_num: null }), false);
  const appliedFilters = [];
  applyFloorPreview({
    prepared: plan,
    layerIds: {
      filterHighlightFillLayerIds: ['legacy-buildings'],
      buildingPartFilterHighlightLineLayerIds: ['legacy-parts']
    },
    map: {
      getLayer: (id) => ({ id }),
      setFilter: (_id, expression) => appliedFilters.push(expression),
      setPaintProperty: () => {}
    }
  });
  assert.equal(appliedFilters.length, 2);
  for (const expression of appliedFilters) {
    const compiled = createExpression(expression, { type: 'boolean' });
    assert.equal(compiled.result, 'success');
    assert.equal(compiled.value.evaluate({ zoom: 14 }, { type: 'Polygon', properties: {} }), false);
    assert.equal(
      compiled.value.evaluate(
        { zoom: 14 },
        { type: 'Polygon', properties: { building: 'yes', filter_levels: '7', filter_levels_num: 7 } }
      ),
      false
    );
  }
  assert.equal(
    buildFloorPreviewExpressions(prepareFilterRequestPlan([{ key: 'archi.levels', op: 'equals', value: '5' }])),
    null
  );
});

test('floor preview is replaced by the mandatory authoritative response', async (t) => {
  const { createFilterPipeline } = await load('services/map/map-filter-pipeline.ts');
  let finish;
  let applied;
  let started;
  const response = new Promise((resolve) => {
    finish = resolve;
  });
  const requestStarted = new Promise((resolve) => {
    started = resolve;
  });
  const completed = new Promise((resolve) => {
    applied = resolve;
  });
  const filters = [];
  t.mock.method(globalThis, 'fetch', async () => {
    started();
    return response;
  });
  const pipeline = createFilterPipeline({
    map: {
      getBounds: () => ({ getWest: () => 44, getSouth: () => 56, getEast: () => 44.1, getNorth: () => 56.1 }),
      getZoom: () => 14,
      getLayer: (id) => (id === 'highlight' ? { id } : null),
      setPaintProperty: () => {},
      setFilter: (_id, expression) => filters.push(expression)
    },
    getLayerIds: () => ({ filterHighlightFillLayerIds: ['highlight'] }),
    onStatusChange: (status) => {
      if (status.statusCode === 'applied') applied();
    }
  });
  t.after(() => pipeline.destroy());
  await pipeline.applyBuildingFilters([{ key: 'building:levels', op: 'equals', value: '5' }]);
  assert.match(JSON.stringify(filters.at(-1)), /filter_schema/);
  await requestStarted;
  finish(json({ matchedKeys: ['way/123'], matchedFeatureIds: [246], meta: {} }));
  await completed;
  assert.doesNotMatch(JSON.stringify(filters.at(-1)), /filter_schema/);
  assert.match(JSON.stringify(filters.at(-1)), /246|way\/123/);
});

test('offline fallback removes the provisional floor colors', async (t) => {
  const { createFilterPipeline } = await load('services/map/map-filter-pipeline.ts');
  const filters = [];
  let failed;
  const completed = new Promise((resolve) => {
    failed = resolve;
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
  const pipeline = createFilterPipeline({
    map: {
      getBounds: () => ({ getWest: () => 44, getSouth: () => 56, getEast: () => 44.1, getNorth: () => 56.1 }),
      getZoom: () => 14,
      getLayer: (id) => (id === 'highlight' ? { id } : null),
      setPaintProperty: () => {},
      setFilter: (_id, expression) => filters.push(expression)
    },
    getLayerIds: () => ({ filterHighlightFillLayerIds: ['highlight'] }),
    onStatusChange: (status) => {
      if (status.statusCode === 'failed' || status.statusCode === 'applied') failed();
    }
  });
  t.after(() => pipeline.destroy());
  await pipeline.applyBuildingFilters([{ key: 'building:levels', op: 'equals', value: '5' }]);
  assert.match(JSON.stringify(filters.at(-1)), /filter_schema/);
  await completed;
  assert.doesNotMatch(JSON.stringify(filters.at(-1)), /filter_schema/);
});

test('stale Overpass tiles remain available offline and revalidate after reconnecting', async (t) => {
  const { get } = await import('svelte/store');
  const overpass = await load('services/map/overpass-buildings.ts');
  const { OVERPASS_TILE_TTL_MS } = await load('services/map/overpass-cache-policy.ts');
  overpass.resetOverpassState();
  await overpass.clearOverpassCache();
  const onlineDescriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  let online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  t.after(() => {
    overpass.resetOverpassState();
    if (onlineDescriptor) Object.defineProperty(navigator, 'onLine', onlineDescriptor);
    else delete (navigator as any).onLine;
  });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return json({
      elements: [
        {
          type: 'way',
          id: 123,
          tags: { building: 'yes' },
          nodes: [1, 2, 3, 1],
          geometry: [
            { lon: 44, lat: 56 },
            { lon: 44.001, lat: 56 },
            { lon: 44, lat: 56.001 },
            { lon: 44, lat: 56 }
          ]
        }
      ]
    });
  });
  const context = { viewport: { west: 44, south: 56, east: 44.0001, north: 56.0001 }, zoom: 14, covered: false };
  await overpass.requestOverpassViewportLoad(context);
  assert.ok(requests > 0);
  const initialRequests = requests;
  const future = Date.now() + OVERPASS_TILE_TTL_MS + 1;
  t.mock.method(Date, 'now', () => future);
  online = false;
  await overpass.refreshOverpassViewport(context);
  assert.equal(requests, initialRequests);
  assert.ok((get(overpass.overpassBuildingsState) as any).featureCount > 0);
  online = true;
  await overpass.refreshOverpassViewport(context);
  for (let i = 0; i < 20; i += 1) await flush();
  assert.ok(requests > initialRequests);
  assert.equal((get(overpass.overpassBuildingsState) as any).loading, false);
});
