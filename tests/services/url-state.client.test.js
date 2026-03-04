const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadUrlStateModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'client', 'urlState.js');
  return import(pathToFileURL(modulePath).href);
}

test('parseUrlState reads camera, building and admin edit params', async () => {
  const { parseUrlState } = await loadUrlStateModule();
  const state = parseUrlState('http://localhost/app?lat=50.45&lng=30.52&z=15.5&building=way/123&edit=42');
  assert.deepEqual(state.camera, { lat: 50.45, lng: 30.52, z: 15.5 });
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

test('patchUrlState updates camera and deep-link params deterministically', async () => {
  const { patchUrlState } = await loadUrlStateModule();
  const current = new URL('http://localhost/app?foo=1&adminEdit=9');
  const next = patchUrlState(current, {
    camera: { lat: 10.12345678, lng: 20.87654321, z: 16.9876 },
    building: { osmType: 'relation', osmId: 77 },
    editId: 12
  });

  assert.equal(next.searchParams.get('foo'), '1');
  assert.equal(next.searchParams.get('lat'), '10.123457');
  assert.equal(next.searchParams.get('lng'), '20.876543');
  assert.equal(next.searchParams.get('z'), '16.99');
  assert.equal(next.searchParams.get('building'), 'relation/77');
  assert.equal(next.searchParams.get('edit'), '12');
  assert.equal(next.searchParams.has('adminEdit'), false);
});
