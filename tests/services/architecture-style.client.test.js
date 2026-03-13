const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('url');

async function loadArchitectureStyleModule() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'utils', 'architecture-style-regions.js');
  return import(pathToFileURL(modulePath).href);
}

test('isArchitectureStyleAllowed keeps global behavior when region filters are omitted', async () => {
  const { isArchitectureStyleAllowed } = await loadArchitectureStyleModule();

  assert.equal(isArchitectureStyleAllowed('classic_swahili'), true);
  assert.equal(isArchitectureStyleAllowed('mamluk'), true);
  assert.equal(isArchitectureStyleAllowed('pseudo-russian'), true);
});

test('isArchitectureStyleAllowed applies default macro-region restrictions', async () => {
  const { isArchitectureStyleAllowed } = await loadArchitectureStyleModule();

  assert.equal(isArchitectureStyleAllowed('classic_swahili', ['ru-moscow']), false);
  assert.equal(isArchitectureStyleAllowed('mamluk', ['ru-moscow']), false);
  assert.equal(isArchitectureStyleAllowed('amsterdam_school', ['ru-moscow']), false);
  assert.equal(isArchitectureStyleAllowed('nothern_modern', ['ru-moscow']), true);
  assert.equal(isArchitectureStyleAllowed('stalinist_neoclassicism', ['pl-warsaw']), true);
  assert.equal(isArchitectureStyleAllowed('stalinist_neoclassicism', ['de-berlin']), true);
  assert.equal(isArchitectureStyleAllowed('postconstructivism', ['ru-moscow']), true);
  assert.equal(isArchitectureStyleAllowed('pseudo-russian', ['ru-moscow']), true);
  assert.equal(isArchitectureStyleAllowed('russian_gothic', ['ru-moscow']), true);
  assert.equal(isArchitectureStyleAllowed('gothic', ['ru-moscow']), true);
});

test('isArchitectureStyleAllowed applies Tanzania-wide restrictions for Zanzibar-marked styles', async () => {
  const { isArchitectureStyleAllowed } = await loadArchitectureStyleModule();

  assert.equal(isArchitectureStyleAllowed('omani', ['tz-zanzibar']), true);
  assert.equal(isArchitectureStyleAllowed('omani', ['tz-dar-es-salaam']), true);
  assert.equal(isArchitectureStyleAllowed('indian', ['tz-zanzibar']), true);
  assert.equal(isArchitectureStyleAllowed('british_colonial', ['tz-zanzibar-central-south']), true);
  assert.equal(isArchitectureStyleAllowed('modernism', ['tz-dodoma']), true);
  assert.equal(isArchitectureStyleAllowed('hypermodern', ['ru-moscow']), false);
});

test('isArchitectureStyleAllowed applies allow and deny overrides with specificity', async () => {
  const { isArchitectureStyleAllowed } = await loadArchitectureStyleModule();

  assert.equal(isArchitectureStyleAllowed('omani', ['ru-tatarstan'], [
    { id: 1, region_pattern: 'ru-*', style_key: 'omani', is_allowed: true }
  ]), true);

  assert.equal(isArchitectureStyleAllowed('pseudo-russian', ['ru-kaliningrad'], [
    { id: 2, region_pattern: 'ru-*', style_key: 'pseudo-russian', is_allowed: true },
    { id: 3, region_pattern: 'ru-kaliningrad', style_key: 'pseudo-russian', is_allowed: false }
  ]), false);

  assert.equal(isArchitectureStyleAllowed('gothic', ['de-berlin'], [
    { id: 4, region_pattern: '*', style_key: 'gothic', is_allowed: false },
    { id: 5, region_pattern: 'de-*', style_key: 'gothic', is_allowed: true }
  ]), true);

  assert.equal(isArchitectureStyleAllowed('gothic', ['ru-moscow'], [
    { id: 4, region_pattern: '*', style_key: 'gothic', is_allowed: false },
    { id: 5, region_pattern: 'de-*', style_key: 'gothic', is_allowed: true }
  ]), false);
});

test('default style maps cover regional styles while leaving other styles global', async () => {
  const { STYLE_ALLOWED_REGION_PATTERNS, STYLE_ALLOWED_REGIONS } = await loadArchitectureStyleModule();

  assert.deepEqual(STYLE_ALLOWED_REGIONS.amsterdam_school, ['nl']);
  assert.ok(Array.isArray(STYLE_ALLOWED_REGIONS.victorian));
  assert.ok(STYLE_ALLOWED_REGIONS.victorian.includes('gb'));
  assert.ok(STYLE_ALLOWED_REGIONS.victorian.includes('us'));
  assert.ok(Array.isArray(STYLE_ALLOWED_REGIONS.nothern_modern));
  assert.ok(STYLE_ALLOWED_REGIONS.nothern_modern.includes('ru'));
  assert.ok(Array.isArray(STYLE_ALLOWED_REGIONS.stalinist_neoclassicism));
  assert.ok(STYLE_ALLOWED_REGIONS.stalinist_neoclassicism.includes('pl'));
  assert.ok(STYLE_ALLOWED_REGIONS.stalinist_neoclassicism.includes('cz'));
  assert.ok(STYLE_ALLOWED_REGIONS.stalinist_neoclassicism.includes('de'));
  assert.ok(STYLE_ALLOWED_REGIONS.stalinist_neoclassicism.includes('hu'));
  assert.ok(STYLE_ALLOWED_REGIONS.stalinist_neoclassicism.includes('ro'));
  assert.ok(STYLE_ALLOWED_REGIONS.stalinist_neoclassicism.includes('bg'));
  assert.ok(STYLE_ALLOWED_REGIONS.stalinist_neoclassicism.includes('sk'));
  assert.deepEqual(STYLE_ALLOWED_REGIONS.omani, ['tz']);
  assert.deepEqual(STYLE_ALLOWED_REGIONS.modernism, ['tz']);
  assert.equal(Object.keys(STYLE_ALLOWED_REGION_PATTERNS).length, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(STYLE_ALLOWED_REGIONS, 'gothic'), false);
});
