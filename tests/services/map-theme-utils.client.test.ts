const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

let importCounter = 0;

async function loadMapThemeUtils() {
  const modulePath = path.join(process.cwd(), 'frontend', 'src', 'lib', 'services', 'map', 'map-theme-utils.ts');
  return import(`${pathToFileURL(modulePath).href}?v=${importCounter += 1}`);
}

function createMapTilerStyleFixture() {
  return {
    version: 8,
    sources: {
      maptiler_planet: {
        type: 'vector',
        url: 'https://api.maptiler.com/tiles/v3/tiles.json?key=test-key'
      }
    },
    layers: [
      {
        id: 'Public',
        type: 'symbol',
        source: 'maptiler_planet',
        'source-layer': 'poi',
        layout: {
          'text-field': '{name}'
        }
      },
      {
        id: 'Road labels',
        type: 'symbol',
        source: 'maptiler_planet',
        'source-layer': 'transportation_name',
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']]
        }
      },
      {
        id: 'Airport',
        type: 'symbol',
        source: 'maptiler_planet',
        'source-layer': 'aeroway',
        layout: {
          'text-field': {
            stops: [
              [8, ' '],
              [9, '{iata}'],
              [12, '{name:en}']
            ]
          }
        }
      },
      {
        id: 'Highway shield',
        type: 'symbol',
        source: 'maptiler_planet',
        'source-layer': 'transportation_name',
        layout: {
          'text-field': '{ref}'
        }
      },
      {
        id: 'City labels',
        type: 'symbol',
        source: 'maptiler_planet',
        'source-layer': 'place',
        layout: {
          'text-field': '{name:en}'
        }
      },
      {
        id: 'Building 3D',
        type: 'fill-extrusion',
        source: 'maptiler_planet',
        'source-layer': 'building',
        layout: {}
      },
      {
        id: 'Ferry line',
        type: 'line',
        source: 'maptiler_planet',
        'source-layer': 'transportation',
        filter: ['==', 'class', 'ferry'],
        layout: {}
      },
      {
        id: 'Ferry',
        type: 'symbol',
        source: 'maptiler_planet',
        'source-layer': 'transportation_name',
        filter: ['==', 'class', 'ferry'],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']]
        }
      },
      {
        id: 'Minor road',
        type: 'line',
        source: 'maptiler_planet',
        'source-layer': 'transportation',
        filter: ['all', ['!=', 'brunnel', 'tunnel'], ['!in', 'class', 'aerialway', 'bridge', 'ferry']],
        layout: {}
      }
    ]
  };
}

test('transformMapTilerStyle hides POI layers and localizes labels for Russian locale', async () => {
  const { transformMapTilerStyle } = await loadMapThemeUtils();
  const sourceStyle = createMapTilerStyleFixture();

  const transformedStyle = transformMapTilerStyle(sourceStyle, {
    localeCode: 'ru-RU'
  });

  const poiLayer = transformedStyle.layers.find((layer) => layer.id === 'Public');
  const roadLabels = transformedStyle.layers.find((layer) => layer.id === 'Road labels');
  const airportLabels = transformedStyle.layers.find((layer) => layer.id === 'Airport');
  const highwayShield = transformedStyle.layers.find((layer) => layer.id === 'Highway shield');
  const cityLabels = transformedStyle.layers.find((layer) => layer.id === 'City labels');
  const building3dLayer = transformedStyle.layers.find((layer) => layer.id === 'Building 3D');
  const ferryLineLayer = transformedStyle.layers.find((layer) => layer.id === 'Ferry line');
  const ferryLabelLayer = transformedStyle.layers.find((layer) => layer.id === 'Ferry');
  const minorRoadLayer = transformedStyle.layers.find((layer) => layer.id === 'Minor road');
  const poiLayout = poiLayer.layout as any;
  const sourcePoiLayout = sourceStyle.layers[0].layout as any;
  const building3dLayout = building3dLayer.layout as any;
  const ferryLineLayout = ferryLineLayer.layout as any;
  const ferryLabelLayout = ferryLabelLayer.layout as any;
  const minorRoadLayout = minorRoadLayer.layout as any;

  assert.notEqual(transformedStyle, sourceStyle);
  assert.equal(sourcePoiLayout.visibility, undefined);
  assert.equal(poiLayout.visibility, 'none');
  assert.equal(building3dLayout.visibility, 'none');
  assert.equal(ferryLineLayout.visibility, 'none');
  assert.equal(ferryLabelLayout.visibility, 'none');
  assert.equal(minorRoadLayout.visibility, undefined);
  assert.deepEqual(poiLayer.layout['text-field'], [
    'coalesce',
    ['get', 'name:ru'],
    ['get', 'name'],
    ['get', 'name:en']
  ]);
  assert.deepEqual(roadLabels.layout['text-field'], [
    'coalesce',
    ['get', 'name:ru'],
    ['get', 'name'],
    ['get', 'name:en']
  ]);
  assert.deepEqual(airportLabels.layout['text-field'], [
    'step',
    ['zoom'],
    ' ',
    9,
    ['coalesce', ['get', 'iata'], ''],
    12,
    ['coalesce', ['get', 'name:ru'], ['get', 'name'], ['get', 'name:en']]
  ]);
  assert.equal(highwayShield.layout['text-field'], '{ref}');
  assert.deepEqual(cityLabels.layout['text-field'], [
    'coalesce',
    ['get', 'name:ru'],
    ['get', 'name'],
    ['get', 'name:en']
  ]);
  assert.deepEqual(ferryLabelLayer.layout['text-field'], [
    'coalesce',
    ['get', 'name:ru'],
    ['get', 'name'],
    ['get', 'name:en']
  ]);
});

test('getMapStyleSignature tracks locale only for MapTiler styles', async () => {
  const { getMapStyleSignature } = await loadMapThemeUtils();

  const mapTilerConfig = {
    basemap: {
      provider: 'maptiler',
      maptilerApiKey: 'public-demo-key'
    }
  };
  const cartoConfig = {
    basemap: {
      provider: 'carto'
    }
  };

  assert.notEqual(
    getMapStyleSignature('light', mapTilerConfig, 'ru'),
    getMapStyleSignature('light', mapTilerConfig, 'en')
  );
  assert.equal(
    getMapStyleSignature('light', cartoConfig, 'ru'),
    getMapStyleSignature('light', cartoConfig, 'en')
  );
});

test('resolveMapStyleForTheme caches transformed MapTiler styles per locale', async () => {
  const { resolveMapStyleForTheme } = await loadMapThemeUtils();
  const runtimeConfig = {
    basemap: {
      provider: 'maptiler',
      maptilerApiKey: 'public-demo-key'
    }
  };

  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify(createMapTilerStyleFixture()), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  };

  const firstRuStyle = await resolveMapStyleForTheme('light', {
    runtimeConfig,
    localeCode: 'ru',
    fetchImpl
  });
  const secondRuStyle = await resolveMapStyleForTheme('light', {
    runtimeConfig,
    localeCode: 'ru',
    fetchImpl
  });
  const englishStyle = await resolveMapStyleForTheme('light', {
    runtimeConfig,
    localeCode: 'en',
    fetchImpl
  });

  assert.equal(fetchCalls, 2);
  assert.notEqual(firstRuStyle, secondRuStyle);
  assert.deepEqual(firstRuStyle, secondRuStyle);
  assert.notDeepEqual(firstRuStyle, englishStyle);
});
