const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createCountrySubregionsCatalog } = require('../../src/lib/server/services/data-settings/country-subregions.ts');
const { createRegionCatalog } = require('../../src/lib/server/services/data-settings/region-catalog.ts');

const regionCatalog = createRegionCatalog({
  catalogPath: path.resolve(__dirname, '..', '..', 'src', 'lib', 'server', 'data', 'region-catalog.json')
});

test('country subregions catalog resolves countries and hidden subregions from the local manifest', async () => {
  const catalog = createCountrySubregionsCatalog({
    regionCatalog
  });

  const countryMatch = await catalog.findByExtractId('poland');
  assert.ok(countryMatch);
  assert.equal(countryMatch.country.countryId, 'poland');
  assert.equal(countryMatch.subregion, null);

  const subregionMatch = await catalog.findByExtractId('dolnoslaskie');
  assert.ok(subregionMatch);
  assert.equal(subregionMatch.country.countryId, 'poland');
  assert.equal(subregionMatch.subregion?.extractId, 'dolnoslaskie');
  assert.equal(
    subregionMatch.subregion?.pbfUrl,
    'https://download.geofabrik.de/europe/poland/dolnoslaskie-latest.osm.pbf'
  );
});

test('country subregions catalog lists aggregate-eligible countries from the local manifest', async () => {
  const catalog = createCountrySubregionsCatalog({
    regionCatalog
  });

  const countries = await catalog.getCountries();
  const poland = countries.find((country) => country.countryId === 'poland');

  assert.ok(poland);
  assert.equal(poland.iso, 'PL');
  assert.ok(Array.isArray(poland.subregions));
  assert.ok(poland.subregions.length > 0);
});
