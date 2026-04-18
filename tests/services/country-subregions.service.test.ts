const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCountrySubregionsCatalog } = require('../../src/lib/server/services/data-settings/country-subregions.ts');

function createJsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body
  };
}

test('country subregions catalog matches Geofabrik canonical extract ids derived from pbf URLs', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-country-subregions-'));
  const catalog = createCountrySubregionsCatalog({
    dataDir: tempDir,
    cacheTtlMs: 60_000,
    fetchImpl: async () =>
      createJsonResponse({
        features: [
          {
            properties: {
              id: 'europe',
              name: 'Europe',
              urls: {
                pbf: 'https://download.geofabrik.de/europe-latest.osm.pbf'
              }
            },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [0.0, 40.0],
                  [30.0, 40.0],
                  [30.0, 60.0],
                  [0.0, 60.0],
                  [0.0, 40.0]
                ]
              ]
            }
          },
          {
            properties: {
              id: 'poland',
              parent: 'europe',
              name: 'Poland',
              'iso3166-1:alpha2': ['PL'],
              urls: {
                pbf: 'https://download.geofabrik.de/europe/poland-latest.osm.pbf'
              }
            },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [14.0, 49.0],
                  [24.0, 49.0],
                  [24.0, 55.0],
                  [14.0, 55.0],
                  [14.0, 49.0]
                ]
              ]
            }
          },
          {
            properties: {
              id: 'poland/dolnoslaskie',
              parent: 'poland',
              name: 'Dolnoslaskie',
              'iso3166-2': ['PL-02'],
              urls: {
                pbf: 'https://download.geofabrik.de/europe/poland/dolnoslaskie-latest.osm.pbf'
              }
            },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [16.0, 50.0],
                  [17.5, 50.0],
                  [17.5, 51.5],
                  [16.0, 51.5],
                  [16.0, 50.0]
                ]
              ]
            }
          }
        ]
      })
  });

  try {
    const countryMatch = await catalog.findByExtractId('geofabrik_europe_poland');
    assert.ok(countryMatch);
    assert.equal(countryMatch.country.countryId, 'poland');
    assert.equal(countryMatch.subregion, null);

    const subregionMatch = await catalog.findByExtractId('geofabrik_europe_poland_dolnoslaskie');
    assert.ok(subregionMatch);
    assert.equal(subregionMatch.country.countryId, 'poland');
    assert.equal(subregionMatch.subregion?.extractId, 'poland/dolnoslaskie');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('country subregions catalog refreshes legacy cache files without version metadata', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archimap-country-subregions-cache-'));
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, 'country-subregions.json'),
    JSON.stringify(
      {
        loadedAt: Date.now(),
        countries: [
          {
            countryId: 'antarctica',
            name: 'Antarctica',
            iso: 'AQ',
            bounds: null,
            pbfUrl: 'https://download.geofabrik.de/antarctica-latest.osm.pbf',
            subregions: []
          }
        ]
      },
      null,
      2
    ),
    'utf8'
  );

  let fetchCalls = 0;
  const catalog = createCountrySubregionsCatalog({
    dataDir: tempDir,
    cacheTtlMs: 60_000,
    fetchImpl: async () => {
      fetchCalls += 1;
      return createJsonResponse({
        features: [
          {
            properties: {
              id: 'europe',
              name: 'Europe',
              urls: {
                pbf: 'https://download.geofabrik.de/europe-latest.osm.pbf'
              }
            },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [0.0, 40.0],
                  [30.0, 40.0],
                  [30.0, 60.0],
                  [0.0, 60.0],
                  [0.0, 40.0]
                ]
              ]
            }
          },
          {
            properties: {
              id: 'poland',
              parent: 'europe',
              name: 'Poland',
              'iso3166-1:alpha2': ['PL'],
              urls: {
                pbf: 'https://download.geofabrik.de/europe/poland-latest.osm.pbf'
              }
            },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [14.0, 49.0],
                  [24.0, 49.0],
                  [24.0, 55.0],
                  [14.0, 55.0],
                  [14.0, 49.0]
                ]
              ]
            }
          },
          {
            properties: {
              id: 'poland/dolnoslaskie',
              parent: 'poland',
              name: 'Dolnoslaskie',
              'iso3166-2': ['PL-02'],
              urls: {
                pbf: 'https://download.geofabrik.de/europe/poland/dolnoslaskie-latest.osm.pbf'
              }
            },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [16.0, 50.0],
                  [17.5, 50.0],
                  [17.5, 51.5],
                  [16.0, 51.5],
                  [16.0, 50.0]
                ]
              ]
            }
          }
        ]
      });
    }
  });

  try {
    const countries = await catalog.getCountries();
    assert.equal(fetchCalls, 1);
    assert.equal(countries.length, 1);
    assert.equal(countries[0].countryId, 'poland');
    assert.equal(countries[0].subregions.length, 1);

    const cached = JSON.parse(fs.readFileSync(path.join(tempDir, 'country-subregions.json'), 'utf8'));
    assert.equal(Number(cached.version || 0) > 0, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
