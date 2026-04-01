const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadUrlStateModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'client', 'urlState.ts');
  return import(pathToFileURL(modulePath).href);
}

async function loadFilterUrlStateModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'client', 'filterUrlState.ts');
  return import(pathToFileURL(modulePath).href);
}

test('parseUrlState reads camera, 3d, building and admin edit params', async () => {
  const { parseUrlState } = await loadUrlStateModule();
  const state = parseUrlState('http://localhost/app?lat=50.45&lng=30.52&z=15.5&pitch=58.25&bearing=-17.5&3d=1&building=way/123&edit=42');
  assert.deepEqual(state.camera, {
    lat: 50.45,
    lng: 30.52,
    z: 15.5,
    pitch: 58.25,
    bearing: -17.5
  });
  assert.equal(state.buildings3dEnabled, true);
  assert.deepEqual(state.building, { osmType: 'way', osmId: 123 });
  assert.equal(state.editId, 42);
});

test('parseUrlState supports compatibility info params', async () => {
  const { parseUrlState } = await loadUrlStateModule();
  const legacy = parseUrlState('http://localhost/info?tab=user-agreement');
  assert.deepEqual(legacy.info, { tab: 'legal', doc: 'terms' });

  const modern = parseUrlState('http://localhost/info?tab=legal&doc=privacy');
  assert.deepEqual(modern.info, { tab: 'legal', doc: 'privacy' });
});

test('parseUrlState does not coerce missing zoom to zero', async () => {
  const { parseUrlState } = await loadUrlStateModule();
  const state = parseUrlState('http://localhost/app?lat=56.3269&lng=44.0059');
  assert.deepEqual(state.camera, { lat: 56.3269, lng: 44.0059, z: null });
});

test('patchUrlState updates camera, 3d and deep-link params deterministically', async () => {
  const { patchUrlState } = await loadUrlStateModule();
  const { encodeFilterLayersForUrl } = await loadFilterUrlStateModule();
  const current = new URL('http://localhost/app?foo=1&adminEdit=9&3d=0&pitch=44&bearing=12');
  const filters = [
    {
      color: '#f59e0b',
      mode: 'and',
      rules: [
        { key: 'building:levels', op: 'greater_or_equals', value: '5' }
      ]
    },
    {
      color: '#3b82f6',
      mode: 'layer',
      rules: [
        { key: 'building:material', op: 'equals', value: 'brick' }
      ]
    }
  ];
  const next = patchUrlState(current, {
    camera: { lat: 10.12345678, lng: 20.87654321, z: 16.9876, pitch: 61.1234, bearing: -17.8765 },
    buildings3dEnabled: true,
    filters,
    building: { osmType: 'relation', osmId: 77 },
    editId: 12
  });

  assert.equal(next.searchParams.get('foo'), '1');
  assert.equal(next.searchParams.get('lat'), '10.123457');
  assert.equal(next.searchParams.get('lng'), '20.876543');
  assert.equal(next.searchParams.get('z'), '16.99');
  assert.equal(next.searchParams.get('pitch'), '61.12');
  assert.equal(next.searchParams.get('bearing'), '-17.88');
  assert.equal(next.searchParams.get('3d'), '1');
  assert.equal(next.searchParams.get('f'), encodeFilterLayersForUrl(filters));
  assert.equal(next.searchParams.get('building'), 'relation/77');
  assert.equal(next.searchParams.get('edit'), '12');
  assert.equal(next.searchParams.has('adminEdit'), false);
});

test('patchUrlState clears 3d camera orientation when 3d buildings are disabled', async () => {
  const { patchUrlState } = await loadUrlStateModule();
  const next = patchUrlState('http://localhost/app?lat=1&lng=2&z=3&pitch=45&bearing=90&3d=1', {
    camera: { lat: 1, lng: 2, z: 3, pitch: 45, bearing: 90 },
    buildings3dEnabled: false
  });

  assert.equal(next.searchParams.get('3d'), '0');
  assert.equal(next.searchParams.has('pitch'), false);
  assert.equal(next.searchParams.has('bearing'), false);
});

test('parseUrlState decodes filter layers from compact query state', async () => {
  const { parseUrlState } = await loadUrlStateModule();
  const { encodeFilterLayersForUrl } = await loadFilterUrlStateModule();
  const filters = [
    {
      color: '#f59e0b',
      mode: 'or',
      rules: [
        { key: 'name', op: 'contains', value: 'house' },
        { key: 'building:levels', op: 'less_or_equals', value: '3' }
      ]
    }
  ];
  const state = parseUrlState(`http://localhost/app?lat=56.3&lng=44.0&z=13.5&f=${encodeFilterLayersForUrl(filters)}`);
  assert.deepEqual(state.filters, [
    {
      priority: 0,
      color: '#f59e0b',
      mode: 'or',
      rules: [
        { key: 'name', op: 'contains', value: 'house' },
        { key: 'building:levels', op: 'less_or_equals', value: '3' }
      ]
    }
  ]);
});

