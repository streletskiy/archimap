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

test('buildOverpassFeaturePayload preserves render heights derived from explicit height tags', async () => {
  const { buildOverpassFeaturePayload, buildOverpassBuildingDetails } = await loadOverpassDataUtils();

  const feature = {
    type: 'Feature',
    id: 102,
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
      id: 102,
      tags: {
        name: 'Heights House',
        height: '18.5',
        min_height: '5.5'
      }
    }
  };

  const payload = buildOverpassFeaturePayload(feature);
  assert.ok(payload);
  assert.equal(payload.renderHeightMeters, 18.5);
  assert.equal(payload.renderMinHeightMeters, 5.5);

  const details = buildOverpassBuildingDetails(feature);
  assert.ok(details);
  assert.equal(details.renderHeightMeters, 18.5);
  assert.equal(details.renderMinHeightMeters, 5.5);
  assert.equal(details.properties.render_height_m, 18.5);
  assert.equal(details.properties.render_min_height_m, 5.5);
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

test('buildOverpassFeaturePayload derives levels from explicit height tags when building:levels is absent', async () => {
  const { buildOverpassFeaturePayload } = await loadOverpassDataUtils();

  const feature = {
    type: 'Feature',
    id: 203,
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
      type: 'way',
      id: 203,
      tags: {
        'building:part': 'yes',
        height: '18.5',
        min_height: '5.5'
      }
    }
  };

  const payload = buildOverpassFeaturePayload(feature);
  assert.ok(payload);
  assert.equal(payload.levels, '4');
});

test('applyBuildingPartBaseSuppression marks parent buildings that contain building parts', async () => {
  const { applyBuildingPartBaseSuppression } = await loadOverpassDataUtils();

  const features: Array<{
    type: 'Feature';
    geometry: { type: 'Polygon'; coordinates: number[][][] };
    properties: Record<string, unknown>;
  }> = [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [44.0, 56.0],
          [44.01, 56.0],
          [44.01, 56.01],
          [44.0, 56.01],
          [44.0, 56.0]
        ]]
      },
      properties: {
        osm_key: 'relation/12325639',
        feature_kind: 'building'
      }
    },
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [44.002, 56.002],
          [44.004, 56.002],
          [44.004, 56.004],
          [44.002, 56.004],
          [44.002, 56.002]
        ]]
      },
      properties: {
        osm_key: 'relation/12325634',
        feature_kind: 'building_part'
      }
    }
  ];

  applyBuildingPartBaseSuppression(features);

  assert.equal(features[0]?.properties?.render_hide_base_when_parts, 1);
  assert.equal(features[1]?.properties?.render_hide_base_when_parts, 0);
});

test('applyBuildingPartBaseSuppression emits synthetic building_remainder geometry for uncovered parent footprint', async () => {
  const { applyBuildingPartBaseSuppression } = await loadOverpassDataUtils();

  const features: Array<{
    type: 'Feature';
    id: number;
    geometry: { type: 'Polygon'; coordinates: number[][][] };
    properties: Record<string, unknown>;
  }> = [
    {
      type: 'Feature',
      id: 247,
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [44.0, 56.0],
          [44.01, 56.0],
          [44.01, 56.01],
          [44.0, 56.01],
          [44.0, 56.0]
        ]]
      },
      properties: {
        osm_key: 'relation/12325639',
        feature_kind: 'building',
        osm_type: 'relation',
        osm_id: 12325639
      }
    },
    {
      type: 'Feature',
      id: 248,
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [44.005, 56.0],
          [44.01, 56.0],
          [44.01, 56.01],
          [44.005, 56.01],
          [44.005, 56.0]
        ]]
      },
      properties: {
        osm_key: 'relation/12325634',
        feature_kind: 'building_part',
        osm_type: 'relation',
        osm_id: 12325634
      }
    }
  ];

  const transformed = applyBuildingPartBaseSuppression(features);
  const remainder = transformed.find((feature) => feature?.properties?.feature_kind === 'building_remainder');

  assert.equal(transformed.length, 3);
  assert.equal(features[0]?.properties?.render_hide_base_when_parts, 1);
  assert.ok(remainder);
  assert.equal(remainder.id, 247);
  assert.equal(remainder.properties.render_hide_base_when_parts, 0);
  assert.deepEqual(remainder.geometry, {
    type: 'Polygon',
    coordinates: [[
      [44.0, 56.0],
      [44.005, 56.0],
      [44.005, 56.01],
      [44.0, 56.01],
      [44.0, 56.0]
    ]]
  });
});
