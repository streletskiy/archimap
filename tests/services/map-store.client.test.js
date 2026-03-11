const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const LAST_MAP_CAMERA_STORAGE_KEY = 'archimap-last-map-camera';

async function loadMapStoreModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'stores', 'map.js');
  return import(pathToFileURL(modulePath).href);
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test('getInitialLastMapCamera migrates legacy session storage camera into local storage', async () => {
  const { getInitialLastMapCamera } = await loadMapStoreModule();
  const localStorage = createStorage();
  const sessionStorage = createStorage({
    [LAST_MAP_CAMERA_STORAGE_KEY]: JSON.stringify({ lat: 50.45, lng: 30.52, z: 15.5 })
  });

  const camera = getInitialLastMapCamera({ localStorage, sessionStorage });

  assert.deepEqual(camera, { lat: 50.45, lng: 30.52, z: 15.5 });
  assert.equal(
    localStorage.getItem(LAST_MAP_CAMERA_STORAGE_KEY),
    JSON.stringify({ lat: 50.45, lng: 30.52, z: 15.5 })
  );
});

test('resolveInitialMapCamera prefers URL camera over persisted camera', async () => {
  const { resolveInitialMapCamera } = await loadMapStoreModule();

  const camera = resolveInitialMapCamera({
    url: 'http://localhost/app?lat=40.7128&lng=-74.006&z=13.25',
    persistedCamera: { lat: 56.3269, lng: 44.0059, z: 15 },
    fallbackCamera: { lat: 10, lng: 20, z: 8 }
  });

  assert.deepEqual(camera, { lat: 40.7128, lng: -74.006, z: 13.25 });
});

test('resolveInitialMapCamera uses fallback zoom for URL camera without z', async () => {
  const { resolveInitialMapCamera } = await loadMapStoreModule();

  const camera = resolveInitialMapCamera({
    url: 'http://localhost/app?lat=59.9391&lng=30.3158',
    persistedCamera: { lat: 56.3269, lng: 44.0059, z: 17 },
    fallbackCamera: { lat: 10, lng: 20, z: 8 }
  });

  assert.deepEqual(camera, { lat: 59.9391, lng: 30.3158, z: 8 });
});

test('resolveInitialMapCamera falls back to persisted camera when URL camera is absent', async () => {
  const { resolveInitialMapCamera } = await loadMapStoreModule();

  const camera = resolveInitialMapCamera({
    url: 'http://localhost/app?tab=about',
    persistedCamera: { lat: 56.3269, lng: 44.0059, z: 17 },
    fallbackCamera: { lat: 10, lng: 20, z: 8 }
  });

  assert.deepEqual(camera, { lat: 56.3269, lng: 44.0059, z: 17 });
});

test('requestMapFocus does not coerce missing zoom to zero', async () => {
  const { requestMapFocus, mapFocusRequest } = await loadMapStoreModule();
  let currentValue = null;
  const unsubscribe = mapFocusRequest.subscribe((value) => {
    currentValue = value;
  });

  requestMapFocus({
    lon: 44.0059,
    lat: 56.3269,
    zoom: null,
    duration: 0
  });

  unsubscribe();
  assert.equal(currentValue?.zoom, null);
});
