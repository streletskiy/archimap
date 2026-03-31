const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadOverpassDataUtils() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'overpass-data-utils.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${importCounter += 1}`);
}

test('buildOverpassFeaturePayload normalizes feature tags and geometry center', async () => {
  const { buildOverpassFeaturePayload, buildOverpassSearchItem, buildOverpassBuildingDetails } = await loadOverpassDataUtils();

  const feature = {
    type: 'Feature',
    id: 101,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [37.6, 55.75],
        [37.62, 55.75],
        [37.62, 55.77],
        [37.6, 55.77],
        [37.6, 55.75]
      ]]
    },
    properties: {
      type: 'way',
      id: 101,
      tags: {
        name: 'Villa',
        'building:style': 'constructivism',
        'design:year': '1931',
        'building:levels': '7',
        'year_built': '1932',
        architect: 'Ivan',
        'building:material': 'brick',
        'building:colour': 'red'
      }
    }
  };

  const payload = buildOverpassFeaturePayload(feature, { tileKey: '13/1234/5678' });
  assert.ok(payload);
  assert.equal(payload.osmKey, 'way/101');
  assert.equal(payload.featureKind, 'building');
  assert.equal(payload.name, 'Villa');
  assert.equal(payload.styleRaw, 'constructivism');
  assert.equal(payload.designYear, '1931');
  assert.equal(payload.levels, '7');
  assert.equal(payload.yearBuilt, '1932');
  assert.equal(payload.architect, 'Ivan');
  assert.equal(payload.colour, 'red');
  assert.equal(payload.centerLon, 37.61);
  assert.ok(Math.abs(Number(payload.centerLat) - 55.76) < 1e-9);
  assert.match(payload.searchText, /villa/);

  const searchItem = buildOverpassSearchItem(feature);
  assert.ok(searchItem);
  assert.equal(searchItem.source, 'overpass');
  assert.equal(searchItem.lon, 37.61);
  assert.ok(Math.abs(Number(searchItem.lat) - 55.76) < 1e-9);
  assert.equal(searchItem.featureKind, 'building');

  const details = buildOverpassBuildingDetails(feature);
  assert.ok(details);
  assert.equal(details.source, 'overpass');
  assert.equal(details.feature_kind, 'building');
  assert.equal(details.properties.archiInfo.name, 'Villa');
});

test('buildOverpassFeaturePayload marks building parts and encodes stable ids', async () => {
  const { buildOverpassFeaturePayload, encodeOverpassFeatureId } = await loadOverpassDataUtils();

  const feature = {
    type: 'Feature',
    id: 202,
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [30, 60],
        [30.01, 60],
        [30.01, 60.01],
        [30, 60.01],
        [30, 60]
      ]]
    },
    properties: {
      type: 'relation',
      id: 202,
      tags: {
        'building:part': 'yes',
        name: 'Annex'
      }
    }
  };

  const payload = buildOverpassFeaturePayload(feature);
  assert.ok(payload);
  assert.equal(payload.featureKind, 'building_part');
  assert.equal(payload.osmKey, 'relation/202');
  assert.equal(encodeOverpassFeatureId(feature), 405);
});
