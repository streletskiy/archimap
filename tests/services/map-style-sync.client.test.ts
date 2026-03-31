const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadMapStyleSync() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'map-style-sync.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${importCounter += 1}`);
}

function createDeferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test('createMapStyleSyncController resolves initial style and reapplies style only when signature changes', async () => {
  const { createMapStyleSyncController } = await loadMapStyleSync();
  const appliedStyles = [];
  const map = {
    setStyle(style) {
      appliedStyles.push(style);
    }
  };
  let theme = 'light';
  let localeCode = 'en';
  const runtimeConfig = { id: 'runtime-config' };

  const controller = createMapStyleSyncController({
    getMap: () => map,
    getTheme: () => theme,
    getLocaleCode: () => localeCode,
    getRuntimeConfig: () => runtimeConfig,
    buildStyleSignature: (nextTheme, _runtimeConfig, nextLocale) => `${nextTheme}:${nextLocale}`,
    resolveStyle: async (nextTheme, _runtimeConfig, nextLocale) => `style:${nextTheme}:${nextLocale}`
  });

  assert.equal(await controller.resolveInitialStyle(), 'style:light:en');

  await controller.syncMapStyle();
  assert.deepEqual(appliedStyles, []);

  localeCode = 'ru';
  await controller.syncMapStyle();
  theme = 'dark';
  await controller.syncMapStyle();

  assert.deepEqual(appliedStyles, ['style:light:ru', 'style:dark:ru']);
});

test('createMapStyleSyncController ignores stale async style resolutions and reset cancels pending work', async () => {
  const { createMapStyleSyncController } = await loadMapStyleSync();
  const appliedStyles = [];
  const map = {
    setStyle(style) {
      appliedStyles.push(style);
    }
  };
  let theme = 'light';
  let localeCode = 'en';

  const deferredBySignature = new Map();
  const controller = createMapStyleSyncController({
    getMap: () => map,
    getTheme: () => theme,
    getLocaleCode: () => localeCode,
    getRuntimeConfig: () => undefined,
    buildStyleSignature: (nextTheme, _runtimeConfig, nextLocale) => `${nextTheme}:${nextLocale}`,
    resolveStyle: async (nextTheme, _runtimeConfig, nextLocale) => {
      const signature = `${nextTheme}:${nextLocale}`;
      if (signature === 'light:en') {
        return 'style:light:en';
      }
      const deferred = createDeferred();
      deferredBySignature.set(signature, deferred);
      return deferred.promise;
    }
  });

  await controller.resolveInitialStyle();

  localeCode = 'ru';
  const firstSync = controller.syncMapStyle();
  theme = 'dark';
  const secondSync = controller.syncMapStyle();

  deferredBySignature.get('dark:ru').resolve('style:dark:ru');
  await secondSync;
  assert.deepEqual(appliedStyles, ['style:dark:ru']);

  deferredBySignature.get('light:ru').resolve('style:light:ru');
  await firstSync;
  assert.deepEqual(appliedStyles, ['style:dark:ru']);

  theme = 'light';
  localeCode = 'ru';
  const cancelledSync = controller.syncMapStyle();
  controller.reset();
  deferredBySignature.get('light:ru').resolve('style:light:ru');
  await cancelledSync;
  assert.deepEqual(appliedStyles, ['style:dark:ru']);
});
