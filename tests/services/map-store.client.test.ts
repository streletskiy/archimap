const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const LAST_MAP_CAMERA_STORAGE_KEY = 'archimap-last-map-camera';
const MAP_LABELS_VISIBLE_STORAGE_KEY = 'archimap-map-labels-visible';
const MAP_BUILDING_PARTS_VISIBLE_STORAGE_KEY = 'archimap-map-building-parts-visible';

let mapStoreImportCounter = 0;

async function loadMapStoreModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'stores', 'map.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${mapStoreImportCounter += 1}`);
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
  } as Storage;
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

test('mapLabelsVisible reads persisted value and writes back to storage', async () => {
  const previousWindow = global.window;
  const previousLocalStorage = global.localStorage;
  const storage = createStorage({
    [MAP_LABELS_VISIBLE_STORAGE_KEY]: '0'
  });

  global.window = {} as Window & typeof globalThis;
  global.localStorage = storage;

  try {
    const { mapLabelsVisible, setMapLabelsVisible } = await loadMapStoreModule();
    let currentValue = null;
    const unsubscribe = mapLabelsVisible.subscribe((value) => {
      currentValue = value;
    });

    assert.equal(currentValue, false);

    setMapLabelsVisible(true);
    assert.equal(storage.getItem(MAP_LABELS_VISIBLE_STORAGE_KEY), '1');

    setMapLabelsVisible(false);
    assert.equal(storage.getItem(MAP_LABELS_VISIBLE_STORAGE_KEY), '0');

    unsubscribe();
  } finally {
    if (previousWindow === undefined) {
      delete global.window;
    } else {
      global.window = previousWindow;
    }

    if (previousLocalStorage === undefined) {
      delete global.localStorage;
    } else {
      global.localStorage = previousLocalStorage;
    }
  }
});

test('mapLabelsVisible defaults to true when no stored preference', async () => {
  const previousWindow = global.window;
  const previousLocalStorage = global.localStorage;
  const storage = createStorage();

  global.window = {} as Window & typeof globalThis;
  global.localStorage = storage;

  try {
    const { mapLabelsVisible } = await loadMapStoreModule();
    let currentValue = null;
    const unsubscribe = mapLabelsVisible.subscribe((value) => {
      currentValue = value;
    });

    assert.equal(currentValue, true);
    unsubscribe();
  } finally {
    if (previousWindow === undefined) {
      delete global.window;
    } else {
      global.window = previousWindow;
    }

    if (previousLocalStorage === undefined) {
      delete global.localStorage;
    } else {
      global.localStorage = previousLocalStorage;
    }
  }
});

test('mapBuildingPartsVisible reads persisted value and writes back to storage', async () => {
  const previousWindow = global.window;
  const previousLocalStorage = global.localStorage;
  const storage = createStorage({
    [MAP_BUILDING_PARTS_VISIBLE_STORAGE_KEY]: '0'
  });

  global.window = {} as Window & typeof globalThis;
  global.localStorage = storage;

  try {
    const { mapBuildingPartsVisible, setMapBuildingPartsVisible } = await loadMapStoreModule();
    let currentValue = null;
    const unsubscribe = mapBuildingPartsVisible.subscribe((value) => {
      currentValue = value;
    });

    assert.equal(currentValue, false);

    setMapBuildingPartsVisible(true);
    assert.equal(storage.getItem(MAP_BUILDING_PARTS_VISIBLE_STORAGE_KEY), '1');

    setMapBuildingPartsVisible(false);
    assert.equal(storage.getItem(MAP_BUILDING_PARTS_VISIBLE_STORAGE_KEY), '0');

    unsubscribe();
  } finally {
    if (previousWindow === undefined) {
      delete global.window;
    } else {
      global.window = previousWindow;
    }

    if (previousLocalStorage === undefined) {
      delete global.localStorage;
    } else {
      global.localStorage = previousLocalStorage;
    }
  }
});

test('mapBuildingPartsVisible defaults to false when no stored preference', async () => {
  const previousWindow = global.window;
  const previousLocalStorage = global.localStorage;
  const storage = createStorage();

  global.window = {} as Window & typeof globalThis;
  global.localStorage = storage;

  try {
    const { mapBuildingPartsVisible } = await loadMapStoreModule();
    let currentValue = null;
    const unsubscribe = mapBuildingPartsVisible.subscribe((value) => {
      currentValue = value;
    });

    assert.equal(currentValue, false);
    unsubscribe();
  } finally {
    if (previousWindow === undefined) {
      delete global.window;
    } else {
      global.window = previousWindow;
    }

    if (previousLocalStorage === undefined) {
      delete global.localStorage;
    } else {
      global.localStorage = previousLocalStorage;
    }
  }
});

test('mapBuildingPartsVisible defaults to false during SSR when window is unavailable', async () => {
  const previousWindow = global.window;
  const previousLocalStorage = global.localStorage;

  if (typeof global.window !== 'undefined') {
    delete global.window;
  }
  if (typeof global.localStorage !== 'undefined') {
    delete global.localStorage;
  }

  try {
    const { mapBuildingPartsVisible } = await loadMapStoreModule();
    let currentValue = null;
    const unsubscribe = mapBuildingPartsVisible.subscribe((value) => {
      currentValue = value;
    });

    assert.equal(currentValue, false);
    unsubscribe();
  } finally {
    if (previousWindow === undefined) {
      delete global.window;
    } else {
      global.window = previousWindow;
    }

    if (previousLocalStorage === undefined) {
      delete global.localStorage;
    } else {
      global.localStorage = previousLocalStorage;
    }
  }
});

