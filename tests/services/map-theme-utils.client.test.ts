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

test('getMapStyleSignature tracks custom basemap url and api key', async () => {
  const { getMapStyleSignature } = await loadMapThemeUtils();

  const baseConfig = {
    basemap: {
      provider: 'custom',
      customBasemapUrl: 'https://tiles.example.com/current.json',
      customBasemapApiKey: 'key-1'
    }
  };
  const changedUrlConfig = {
    basemap: {
      provider: 'custom',
      customBasemapUrl: 'https://tiles.example.com/other.json',
      customBasemapApiKey: 'key-1'
    }
  };
  const changedKeyConfig = {
    basemap: {
      provider: 'custom',
      customBasemapUrl: 'https://tiles.example.com/current.json',
      customBasemapApiKey: 'key-2'
    }
  };

  assert.notEqual(
    getMapStyleSignature('light', baseConfig, 'en'),
    getMapStyleSignature('dark', baseConfig, 'en')
  );
  assert.notEqual(
    getMapStyleSignature('light', baseConfig, 'en'),
    getMapStyleSignature('light', changedUrlConfig, 'en')
  );
  assert.notEqual(
    getMapStyleSignature('light', baseConfig, 'en'),
    getMapStyleSignature('light', changedKeyConfig, 'en')
  );
});

test('getMapStyleForTheme returns a high-contrast monochrome Protomaps style for custom basemap', async () => {
  const { getMapStyleForTheme, resolveMapStyleForTheme } = await loadMapThemeUtils();

  const runtimeConfig = {
    basemap: {
      provider: 'custom',
      customBasemapUrl: 'https://tiles.example.com/current.json',
      customBasemapApiKey: 'key-1'
    }
  };

  const previousLocation = globalThis.location;
  const mockLocation = {
    href: 'https://app.example.com/app/',
    origin: 'https://app.example.com'
  } as any;
  (globalThis as any).location = mockLocation;

  try {
    const darkStyle = getMapStyleForTheme('dark', runtimeConfig, 'ru');
    const lightStyle = getMapStyleForTheme('light', runtimeConfig, 'ru');
    const darkBackgroundLayer = darkStyle.layers.find((layer) => layer.id === 'background') as any;
    const darkWaterLayer = darkStyle.layers.find((layer) => layer.id === 'water') as any;
    const darkBuildingsLayer = darkStyle.layers.find((layer) => layer.id === 'buildings') as any;
    const darkRoadLabelsLayer = darkStyle.layers.find((layer) => layer.id === 'roads_labels_major') as any;
    const darkLandcoverLayer = darkStyle.layers.find((layer) => layer.id === 'landcover') as any;
    const lightBackgroundLayer = lightStyle.layers.find((layer) => layer.id === 'background') as any;
    const lightWaterLayer = lightStyle.layers.find((layer) => layer.id === 'water') as any;
    const lightBuildingsLayer = lightStyle.layers.find((layer) => layer.id === 'buildings') as any;
    const lightLanduseParkLayer = lightStyle.layers.find((layer) => layer.id === 'landuse_park') as any;
    const lightParkLayer = lightStyle.layers.find((layer) => layer.id === 'custom-landuse-park') as any;
    const lightGrassLayer = lightStyle.layers.find((layer) => layer.id === 'custom-landuse-grass') as any;
    const lightWoodLayer = lightStyle.layers.find((layer) => layer.id === 'custom-landuse-wood') as any;
    const lightScrubLayer = lightStyle.layers.find((layer) => layer.id === 'custom-landuse-scrub') as any;
    const lightPedestrianOverlayLayer = lightStyle.layers.find((layer) => layer.id === 'custom-landuse-pedestrian') as any;
    const lightLandusePedestrianLayer = lightStyle.layers.find((layer) => layer.id === 'landuse_pedestrian') as any;
    const lightLandcoverLayer = lightStyle.layers.find((layer) => layer.id === 'landcover') as any;
    const lightRoadsOtherLayer = lightStyle.layers.find((layer) => layer.id === 'roads_other') as any;
    const lightRoadsMinorCasingLayer = lightStyle.layers.find((layer) => layer.id === 'roads_minor_casing') as any;
    const lightRoadsMinorLayer = lightStyle.layers.find((layer) => layer.id === 'roads_minor') as any;
    const lightRoadsRailLayer = lightStyle.layers.find((layer) => layer.id === 'roads_rail') as any;
    const lightRoadsRailDashLayer = lightStyle.layers.find((layer) => layer.id === 'custom-roads-rail-dash') as any;
    const lightRoadsSubwayLayer = lightStyle.layers.find((layer) => layer.id === 'custom-roads-subway') as any;
    const lightPedestrianLayer = lightStyle.layers.find((layer) => layer.id === 'custom-roads-pedestrian') as any;
    const lightTramLayer = lightStyle.layers.find((layer) => layer.id === 'custom-roads-tram') as any;
    const lightRoadsTunnelsOtherCasingLayer = lightStyle.layers.find((layer) => layer.id === 'roads_tunnels_other_casing') as any;
    assert.equal(typeof darkStyle, 'object');
    assert.equal(darkStyle.sources?.protomaps?.url, 'https://app.example.com/api/basemaps/custom/current.json');
    assert.equal(darkStyle.glyphs, 'https://app.example.com/basemaps-assets/fonts/{fontstack}/{range}.pbf');
    assert.equal(darkStyle.sprite, 'https://app.example.com/basemaps-assets/sprites/v4/dark');
    assert.equal(lightStyle.sprite, 'https://app.example.com/basemaps-assets/sprites/v4/light');
    assert.equal(darkBackgroundLayer.paint['background-color'], '#101010');
    assert.equal(darkWaterLayer.paint['fill-color'], '#373737');
    assert.equal(darkBuildingsLayer.paint['fill-color'], '#252525');
    assert.equal(darkRoadLabelsLayer.paint['text-color'], '#ededed');
    assert.equal(darkRoadLabelsLayer.paint['text-halo-color'], '#101010');
    assert.equal(darkLandcoverLayer.paint['fill-color'].includes('rgba(28, 28, 28, 1)'), true);
    assert.equal(lightBackgroundLayer.paint['background-color'], '#ffffff');
    assert.equal(lightWaterLayer.paint['fill-color'], '#e8e8e8');
    assert.equal(lightBuildingsLayer.paint['fill-color'], '#cfcfcf');
    assert.equal(lightLanduseParkLayer.paint['fill-color'][6], '#e9e9e9');
    assert.equal(lightLanduseParkLayer.filter[0], 'all');
    assert.deepEqual(lightLanduseParkLayer.filter[2], ['!in', 'kind', 'park', 'grassland', 'grass', 'wood', 'scrub']);
    assert.deepEqual(lightParkLayer.filter, ['==', 'kind', 'park']);
    assert.equal(lightParkLayer.paint['fill-color'], '#f7f7f7');
    assert.equal(lightParkLayer.paint['fill-opacity'], 1);
    assert.deepEqual(lightGrassLayer.filter, ['in', 'kind', 'grassland', 'grass']);
    assert.equal(lightGrassLayer.paint['fill-color'], '#f2f2f2');
    assert.equal(lightGrassLayer.paint['fill-opacity'], 1);
    assert.deepEqual(lightWoodLayer.filter, ['==', 'kind', 'wood']);
    assert.equal(lightWoodLayer.paint['fill-color'], '#d2d2d2');
    assert.equal(lightWoodLayer.paint['fill-opacity'], 0.15);
    assert.deepEqual(lightScrubLayer.filter, ['==', 'kind', 'scrub']);
    assert.equal(lightScrubLayer.paint['fill-color'], '#d2d2d2');
    assert.equal(lightScrubLayer.paint['fill-opacity'], 0.15);
    assert.deepEqual(lightPedestrianOverlayLayer.filter, ['==', 'kind', 'pedestrian']);
    assert.equal(lightPedestrianOverlayLayer.paint['fill-color'], '#ffffff');
    assert.equal(lightPedestrianOverlayLayer.paint['fill-opacity'], 0.5);
    assert.deepEqual(lightLandusePedestrianLayer.filter, ['all', ['in', 'kind', 'pedestrian', 'dam'], ['!in', 'kind', 'pedestrian']]);
    assert.equal(lightLandcoverLayer.paint['fill-color'].includes('rgba(247, 247, 247, 1)'), true);
    assert.equal(lightRoadsOtherLayer.paint['line-color'], '#dbdbdb');
    assert.deepEqual(lightRoadsOtherLayer.filter[lightRoadsOtherLayer.filter.length - 1], [
      '!in',
      'kind_detail',
      'footway',
      'path',
      'cycleway',
      'sidewalk',
      'crossing',
      'steps',
      'tram',
      'funicular',
      'subway'
    ]);
    assert.deepEqual(lightRoadsMinorCasingLayer.filter[lightRoadsMinorCasingLayer.filter.length - 1], [
      '!in',
      'kind_detail',
      'footway',
      'path',
      'cycleway',
      'sidewalk',
      'crossing',
      'steps',
      'tram',
      'funicular',
      'subway'
    ]);
    assert.equal(lightRoadsMinorLayer.paint['line-color'][4], '#dbdbdb');
    assert.equal(lightRoadsMinorLayer.paint['line-color'][6], '#dbdbdb');
    assert.deepEqual(lightRoadsMinorLayer.filter[lightRoadsMinorLayer.filter.length - 1], [
      '!in',
      'kind_detail',
      'footway',
      'path',
      'cycleway',
      'sidewalk',
      'crossing',
      'steps',
      'tram',
      'funicular',
      'subway'
    ]);
    assert.deepEqual(lightRoadsRailLayer.filter, [
      'all',
      ['==', 'kind', 'rail'],
      ['!in', 'kind_detail', 'tram', 'funicular'],
      ['!=', 'kind_detail', 'subway']
    ]);
    assert.equal(lightRoadsRailLayer.paint['line-color'], '#828282');
    assert.equal(lightRoadsRailLayer.paint['line-opacity'], 0.95);
    assert.equal(lightRoadsRailLayer.paint['line-dasharray'], undefined);
    assert.equal(lightRoadsRailLayer.layout['line-cap'], 'butt');
    assert.deepEqual(lightRoadsSubwayLayer.filter, ['==', 'kind_detail', 'subway']);
    assert.equal(lightRoadsSubwayLayer.paint['line-color'], '#a2a2a2');
    assert.equal(lightRoadsSubwayLayer.paint['line-opacity'], 0.38);
    assert.deepEqual(lightRoadsSubwayLayer.paint['line-width'], lightRoadsRailLayer.paint['line-width']);
    assert.equal(lightRoadsRailDashLayer.paint['line-color'], '#ffffff');
    assert.equal(lightRoadsRailDashLayer.paint['line-opacity'], 0.95);
    assert.deepEqual(lightRoadsRailDashLayer.filter, [
      'all',
      ['==', 'kind', 'rail'],
      ['!in', 'kind_detail', 'tram', 'funicular'],
      ['!=', 'kind_detail', 'subway']
    ]);
    assert.deepEqual(lightRoadsRailDashLayer.paint['line-dasharray'], {
      stops: [
        [15, [5, 5]],
        [16, [6, 6]]
      ]
    });
    assert.equal(lightRoadsRailDashLayer.layout['line-cap'], 'butt');
    assert.deepEqual(lightPedestrianLayer.filter, [
      'in',
      'kind_detail',
      'footway',
      'path',
      'cycleway',
      'sidewalk',
      'crossing',
      'steps'
    ]);
    assert.equal(lightPedestrianLayer.paint['line-color'], '#ececec');
    assert.deepEqual(lightPedestrianLayer.paint['line-dasharray'], {
      stops: [
        [15, [2, 2]],
        [18, [3, 3]]
      ]
    });
    assert.deepEqual(lightPedestrianLayer.paint['line-width'], {
      stops: [
        [15, 0.5],
        [16, 1],
        [18, 3]
      ]
    });
    assert.equal(lightTramLayer.paint['line-color'], '#868686');
    assert.deepEqual(lightTramLayer.filter, ['in', 'kind_detail', 'tram', 'funicular']);
    assert.equal(lightTramLayer.paint['line-dasharray'], undefined);
    assert.equal(lightTramLayer.layout['line-cap'], 'round');
    assert.equal(darkStyle.layers.some((layer) => layer.id === 'pois'), false);
    assert.equal(lightStyle.layers.some((layer) => layer.id === 'custom-landuse-grass'), true);
    assert.equal(lightStyle.layers.some((layer) => layer.id === 'custom-landuse-park'), true);
    assert.equal(lightStyle.layers.some((layer) => layer.id === 'custom-landuse-wood'), true);
    assert.equal(lightStyle.layers.some((layer) => layer.id === 'custom-landuse-scrub'), true);
    assert.equal(lightStyle.layers.some((layer) => layer.id === 'custom-landuse-pedestrian'), true);
    assert.equal(lightStyle.layers.some((layer) => layer.id === 'custom-roads-subway'), true);
    assert.equal(lightStyle.layers.some((layer) => layer.id === 'custom-roads-pedestrian'), true);
    assert.equal(lightStyle.layers.some((layer) => layer.id === 'custom-roads-rail-dash'), true);
    assert.equal(lightStyle.layers.some((layer) => layer.id === 'custom-roads-tram'), true);
    assert.equal(lightStyle.layers.some((layer) => layer.id === 'custom-roads-steps'), false);
    assert.ok(
      lightStyle.layers.findIndex((layer) => layer.id === 'landuse_park') <
        lightStyle.layers.findIndex((layer) => layer.id === 'custom-landuse-park') &&
      lightStyle.layers.findIndex((layer) => layer.id === 'custom-landuse-park') <
        lightStyle.layers.findIndex((layer) => layer.id === 'custom-landuse-grass') &&
      lightStyle.layers.findIndex((layer) => layer.id === 'custom-landuse-grass') <
        lightStyle.layers.findIndex((layer) => layer.id === 'custom-landuse-wood') &&
      lightStyle.layers.findIndex((layer) => layer.id === 'custom-landuse-wood') <
        lightStyle.layers.findIndex((layer) => layer.id === 'custom-landuse-scrub') &&
      lightStyle.layers.findIndex((layer) => layer.id === 'custom-landuse-scrub') <
        lightStyle.layers.findIndex((layer) => layer.id === 'custom-landuse-pedestrian') &&
      lightStyle.layers.findIndex((layer) => layer.id === 'custom-landuse-pedestrian') >
        lightStyle.layers.findIndex((layer) => layer.id === 'water') &&
      lightStyle.layers.findIndex((layer) => layer.id === 'custom-landuse-pedestrian') <
        lightStyle.layers.findIndex((layer) => layer.id === lightRoadsTunnelsOtherCasingLayer.id)
    );
    assert.equal(darkStyle.layers.some((layer) => layer.id === 'custom-landuse-park'), false);
    assert.equal(darkStyle.layers.some((layer) => layer.id === 'custom-landuse-grass'), false);
    assert.equal(darkStyle.layers.some((layer) => layer.id === 'custom-landuse-wood'), false);
    assert.equal(darkStyle.layers.some((layer) => layer.id === 'custom-landuse-scrub'), false);
    assert.equal(darkStyle.layers.some((layer) => layer.id === 'custom-landuse-pedestrian'), false);
    assert.equal(darkStyle.layers.some((layer) => layer.id === 'custom-roads-subway'), false);
    assert.equal(darkStyle.layers.some((layer) => layer.id === 'custom-roads-pedestrian'), false);
    assert.equal(darkStyle.layers.some((layer) => layer.id === 'custom-roads-rail-dash'), false);
    assert.equal(darkStyle.layers.some((layer) => layer.id === 'custom-roads-tram'), false);
    assert.equal(darkStyle.layers.some((layer) => layer.id === 'custom-roads-steps'), false);

    let fetchCalls = 0;
    const resolvedStyle = await resolveMapStyleForTheme('dark', {
      runtimeConfig,
      localeCode: 'ru',
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ tiles: ['/current/{z}/{x}/{y}.mvt'] }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
    });

    assert.equal(fetchCalls, 0);
    assert.equal(resolvedStyle.sources?.protomaps?.url, 'https://app.example.com/api/basemaps/custom/current.json');
    assert.equal(resolvedStyle.sources?.protomaps?.tiles, undefined);
    assert.equal(resolvedStyle.sprite, 'https://app.example.com/basemaps-assets/sprites/v4/dark');
    assert.equal(resolvedStyle.glyphs, 'https://app.example.com/basemaps-assets/fonts/{fontstack}/{range}.pbf');
  } finally {
    if (previousLocation === undefined) {
      delete (globalThis as any).location;
    } else {
      (globalThis as any).location = previousLocation;
    }
  }
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
