import { BLACK, WHITE, layers } from '@protomaps/basemaps';
import { getRuntimeConfig } from '../config.js';
import {
  CUSTOM_BASEMAP_TILEJSON_PROXY_URL,
  buildBasemapSourceUrl,
  PROTOMAPS_GLYPHS_PROXY_URL,
  normalizeBasemapApiKey,
  normalizeBasemapProvider,
  buildProtomapsSpriteProxyUrl
} from './basemap-config.js';
import { hasPositiveStyleFilterMatch } from './map-style-filter-utils.js';

export const LIGHT_MAP_STYLE_URL = '/styles/positron-custom.json';
export const DARK_MAP_STYLE_URL = '/styles/dark-matter-custom.json';
export const STYLE_OVERLAY_FADE_MS = 260;
export const MAPTILER_LIGHT_STYLE_ID = 'streets-v2-light';
export const MAPTILER_DARK_STYLE_ID = 'streets-v2-dark';
const MAPTILER_STYLE_CACHE = new Map();
const CUSTOM_STYLE_CACHE = new Map();
const CUSTOM_BASEMAP_LIGHT_GRASS_COLOR = '#f2f2f2';
const CUSTOM_BASEMAP_LIGHT_PARK_OVERLAY_COLOR = '#f7f7f7';
const CUSTOM_BASEMAP_LIGHT_WOOD_COLOR = '#d2d2d2';
const CUSTOM_BASEMAP_LIGHT_WOOD_OPACITY = 0.15;
const CUSTOM_BASEMAP_LIGHT_SCRUB_COLOR = CUSTOM_BASEMAP_LIGHT_WOOD_COLOR;
const CUSTOM_BASEMAP_LIGHT_SCRUB_OPACITY = CUSTOM_BASEMAP_LIGHT_WOOD_OPACITY;
const CUSTOM_BASEMAP_LIGHT_PEDESTRIAN_LANDUSE_COLOR = '#ffffff';
const CUSTOM_BASEMAP_LIGHT_PEDESTRIAN_LANDUSE_OPACITY = 0.5;
const CUSTOM_BASEMAP_LIGHT_PEDESTRIAN_COLOR = '#ececec';
const CUSTOM_BASEMAP_LIGHT_TRAM_COLOR = '#868686';
const CUSTOM_BASEMAP_LIGHT_SUBWAY_COLOR = '#a2a2a2';
const CUSTOM_BASEMAP_LIGHT_RAIL_OUTER_COLOR = '#828282';
const CUSTOM_BASEMAP_LIGHT_RAIL_INNER_COLOR = '#ffffff';
const CUSTOM_BASEMAP_LIGHT_ROAD_COLOR = '#dbdbdb';
const CUSTOM_BASEMAP_SOLID_TRANSIT_KIND_VALUES = ['tram', 'funicular'];
const CUSTOM_BASEMAP_DASHED_KIND_VALUES = [
  'footway',
  'path',
  'cycleway',
  'sidewalk',
  'crossing',
  'steps'
];
const CUSTOM_BASEMAP_DETAILED_KIND_VALUES = [
  ...CUSTOM_BASEMAP_DASHED_KIND_VALUES,
  ...CUSTOM_BASEMAP_SOLID_TRANSIT_KIND_VALUES,
  'subway'
];
const CUSTOM_BASEMAP_LIGHT_RAIL_OUTER_WIDTH = [
  'interpolate',
  ['exponential', 1.3],
  ['zoom'],
  6,
  0.15,
  10,
  0.75,
  12,
  1.2,
  14,
  1.8,
  16,
  3.4,
  20,
  6.6
];
const CUSTOM_BASEMAP_LIGHT_RAIL_INNER_WIDTH = [
  'interpolate',
  ['exponential', 1.3],
  ['zoom'],
  10,
  0.35,
  12,
  0.55,
  14,
  0.8,
  16,
  1.25,
  20,
  4.4
];
const CUSTOM_BASEMAP_LIGHT_RAIL_DASHARRAY = {
  stops: [
    [15, [5, 5]],
    [16, [6, 6]]
  ]
};
const CUSTOM_BASEMAP_LIGHT_PATH_DASHARRAY = {
  stops: [
    [15, [2, 2]],
    [18, [3, 3]]
  ]
};
const CUSTOM_BASEMAP_LIGHT_PATH_WIDTH = {
  stops: [
    [15, 0.5],
    [16, 1],
    [18, 3]
  ]
};

export const BUILDING_THEME = Object.freeze({
  light: {
    fillColor: '#d3d3d1',
    fillOpacity: 1,
    lineColor: '#a9a9a9',
    lineWidth: 0.9,
    lineOpacity: 1
  },
  dark: {
    fillColor: '#64748b',
    fillOpacity: 1,
    lineColor: '#94a3b8',
    lineWidth: 1,
    lineOpacity: 1
  }
});

export const BUILDING_HOVER_THEME = Object.freeze({
  light: {
    fillColor: '#c8bcae',
    fillOpacity: 0.3,
    lineColor: '#7d7063',
    lineWidth: 1.2,
    lineOpacity: 0.9
  },
  dark: {
    fillColor: '#7189a4',
    fillOpacity: 0.3,
    lineColor: '#d7e1ea',
    lineWidth: 1.2,
    lineOpacity: 0.9
  }
});

export function getCurrentTheme(doc = document) {
  return doc?.documentElement?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function getBasemapProvider(runtimeConfig = getRuntimeConfig()) {
  return normalizeBasemapProvider(runtimeConfig?.basemap?.provider);
}

function getMapTilerApiKey(runtimeConfig = getRuntimeConfig()) {
  return normalizeBasemapApiKey(runtimeConfig?.basemap?.maptilerApiKey);
}

function buildMapTilerStyleUrl(styleId, apiKey) {
  return `https://api.maptiler.com/maps/${styleId}/style.json?key=${encodeURIComponent(apiKey)}`;
}

function resolveSameOriginUrl(path) {
  const text = String(path || '').trim();
  if (!text) return text;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return text;
  const baseHref = String(globalThis?.location?.href || globalThis?.window?.location?.href || '').trim();
  if (!baseHref) return text;
  const origin = new URL(baseHref).origin;
  if (text.startsWith('/')) {
    return `${origin}${text}`;
  }
  return new URL(text, baseHref).toString();
}

function getCustomBasemapUrl(runtimeConfig = getRuntimeConfig()) {
  return String(runtimeConfig?.basemap?.customBasemapUrl || '').trim();
}

function getCustomBasemapApiKey(runtimeConfig = getRuntimeConfig()) {
  return normalizeBasemapApiKey(runtimeConfig?.basemap?.customBasemapApiKey);
}

function normalizeThemeVariant(theme) {
  return theme === 'dark' ? 'dark' : 'light';
}

function buildMonochromeLandcoverPalette(theme) {
  const isDark = normalizeThemeVariant(theme) === 'dark';
  return {
    grassland: isDark ? 'rgba(28, 28, 28, 1)' : 'rgba(247, 247, 247, 1)',
    barren: isDark ? 'rgba(36, 36, 36, 1)' : 'rgba(246, 246, 246, 1)',
    urban_area: isDark ? 'rgba(24, 24, 24, 1)' : 'rgba(248, 248, 248, 1)',
    farmland: isDark ? 'rgba(26, 26, 26, 1)' : 'rgba(249, 249, 249, 1)',
    glacier: isDark ? 'rgba(40, 40, 40, 1)' : 'rgba(253, 253, 253, 1)',
    scrub: isDark ? 'rgba(30, 30, 30, 1)' : 'rgba(247, 247, 247, 1)',
    forest: isDark ? 'rgba(22, 22, 22, 1)' : 'rgba(244, 244, 244, 1)'
  };
}

function buildCustomBasemapRoadDetailLayers(theme) {
  if (normalizeThemeVariant(theme) !== 'light') {
    return [];
  }

  return [
    {
      id: 'custom-roads-subway',
      type: 'line',
      source: 'protomaps',
      'source-layer': 'roads',
      minzoom: 10,
      filter: ['==', 'kind_detail', 'subway'],
      layout: {
        'line-cap': 'round',
        'line-join': 'round'
      },
      paint: {
        'line-color': CUSTOM_BASEMAP_LIGHT_SUBWAY_COLOR,
        'line-opacity': 0.38,
        'line-width': CUSTOM_BASEMAP_LIGHT_RAIL_OUTER_WIDTH
      }
    },
    {
      id: 'custom-roads-rail-dash',
      type: 'line',
      source: 'protomaps',
      'source-layer': 'roads',
      minzoom: 10,
      filter: ['all', ['==', 'kind', 'rail'], ['!in', 'kind_detail', ...CUSTOM_BASEMAP_SOLID_TRANSIT_KIND_VALUES], ['!=', 'kind_detail', 'subway']],
      layout: {
        'line-cap': 'butt',
        'line-join': 'round'
      },
      paint: {
        'line-color': CUSTOM_BASEMAP_LIGHT_RAIL_INNER_COLOR,
        'line-opacity': 0.95,
        'line-dasharray': CUSTOM_BASEMAP_LIGHT_RAIL_DASHARRAY,
        'line-width': CUSTOM_BASEMAP_LIGHT_RAIL_INNER_WIDTH
      }
    },
    {
      id: 'custom-roads-pedestrian',
      type: 'line',
      source: 'protomaps',
      'source-layer': 'roads',
      minzoom: 14,
      filter: ['in', 'kind_detail', ...CUSTOM_BASEMAP_DASHED_KIND_VALUES],
      layout: {
        'line-cap': 'round',
        'line-join': 'round'
      },
      paint: {
        'line-color': CUSTOM_BASEMAP_LIGHT_PEDESTRIAN_COLOR,
        'line-opacity': 1,
        'line-dasharray': CUSTOM_BASEMAP_LIGHT_PATH_DASHARRAY,
        'line-width': CUSTOM_BASEMAP_LIGHT_PATH_WIDTH
      }
    },
    {
      id: 'custom-roads-tram',
      type: 'line',
      source: 'protomaps',
      'source-layer': 'roads',
      minzoom: 13,
      filter: ['in', 'kind_detail', ...CUSTOM_BASEMAP_SOLID_TRANSIT_KIND_VALUES],
      layout: {
        'line-cap': 'round',
        'line-join': 'round'
      },
      paint: {
        'line-color': CUSTOM_BASEMAP_LIGHT_TRAM_COLOR,
        'line-opacity': 0.95,
        'line-width': [
          'interpolate',
          ['exponential', 1.2],
          ['zoom'],
          12,
          0.8,
          14,
          1.2,
          16,
          2.2,
          19,
          3.8
        ]
      }
    }
  ];
}

function buildCustomBasemapLanduseDetailLayers(theme) {
  if (normalizeThemeVariant(theme) !== 'light') {
    return [];
  }

  return [
    {
      id: 'custom-landuse-park',
      type: 'fill',
      source: 'protomaps',
      'source-layer': 'landuse',
      filter: ['==', 'kind', 'park'],
      paint: {
        'fill-color': CUSTOM_BASEMAP_LIGHT_PARK_OVERLAY_COLOR,
        'fill-opacity': 1
      }
    },
    {
      id: 'custom-landuse-grass',
      type: 'fill',
      source: 'protomaps',
      'source-layer': 'landuse',
      filter: ['in', 'kind', 'grassland', 'grass'],
      paint: {
        'fill-color': CUSTOM_BASEMAP_LIGHT_GRASS_COLOR,
        'fill-opacity': 1
      }
    },
    {
      id: 'custom-landuse-wood',
      type: 'fill',
      source: 'protomaps',
      'source-layer': 'landuse',
      filter: ['==', 'kind', 'wood'],
      paint: {
        'fill-color': CUSTOM_BASEMAP_LIGHT_WOOD_COLOR,
        'fill-opacity': CUSTOM_BASEMAP_LIGHT_WOOD_OPACITY
      }
    },
    {
      id: 'custom-landuse-scrub',
      type: 'fill',
      source: 'protomaps',
      'source-layer': 'landuse',
      filter: ['==', 'kind', 'scrub'],
      paint: {
        'fill-color': CUSTOM_BASEMAP_LIGHT_SCRUB_COLOR,
        'fill-opacity': CUSTOM_BASEMAP_LIGHT_SCRUB_OPACITY
      }
    }
  ];
}

function buildCustomBasemapPedestrianDetailLayers(theme) {
  if (normalizeThemeVariant(theme) !== 'light') {
    return [];
  }

  return [
    {
      id: 'custom-landuse-pedestrian',
      type: 'fill',
      source: 'protomaps',
      'source-layer': 'landuse',
      filter: ['==', 'kind', 'pedestrian'],
      paint: {
        'fill-color': CUSTOM_BASEMAP_LIGHT_PEDESTRIAN_LANDUSE_COLOR,
        'fill-opacity': CUSTOM_BASEMAP_LIGHT_PEDESTRIAN_LANDUSE_OPACITY
      }
    }
  ];
}

function buildCustomBasemapFlavor(theme) {
  const isDark = normalizeThemeVariant(theme) === 'dark';
  const baseFlavor = isDark ? BLACK : WHITE;
  // Keep the Protomaps layer schema, but use a high-contrast monochrome palette.
  const background = isDark ? '#101010' : '#ffffff';
  const earth = isDark ? '#171717' : '#fcfcfc';
  const water = isDark ? '#373737' : '#e8e8e8';
  const roadCasing = isDark ? '#242424' : '#d3d3d3';
  const roadCasingWide = isDark ? '#303030' : '#c8c8c8';
  const roadFill = isDark ? '#3a3a3a' : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR;
  const roadFillWide = isDark ? '#565656' : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR;
  const labelPrimary = isDark ? '#ededed' : '#454545';
  const labelSecondary = isDark ? '#d0d0d0' : '#6a6a6a';
  const labelTertiary = isDark ? '#aaaaaa' : '#818181';
  const labelHalo = background;
  const buildingFill = isDark ? '#252525' : '#cfcfcf';
  const boundaryColor = isDark ? '#696969' : '#bdbdbd';
  const tunnelCasing = isDark ? '#1f1f1f' : '#dddddd';
  const tunnelFill = isDark ? '#2a2a2a' : '#f1f1f1';
  const bridgeCasing = isDark ? '#2a2a2a' : '#dadada';
  const bridgeFill = isDark ? '#444444' : '#f5f5f5';

  return {
    ...baseFlavor,
    background,
    earth,
    park_a: isDark ? '#1b1b1b' : '#f6f6f6',
    park_b: isDark ? '#202020' : '#f0f0f0',
    hospital: isDark ? '#1c1c1c' : '#f2f2f2',
    industrial: isDark ? '#161616' : '#eeeeee',
    school: isDark ? '#1a1a1a' : '#f1f1f1',
    wood_a: isDark ? '#181818' : '#f4f4f4',
    wood_b: isDark ? '#1d1d1d' : '#ededed',
    pedestrian: isDark ? '#191919' : '#f0f0f0',
    scrub_a: isDark ? '#1b1b1b' : '#f4f4f4',
    scrub_b: isDark ? '#202020' : '#e9e9e9',
    glacier: isDark ? '#161616' : '#fbfbfb',
    sand: isDark ? '#1a1a1a' : '#f5f5f5',
    beach: isDark ? '#212121' : '#efefef',
    aerodrome: isDark ? '#171717' : '#f1f1f1',
    runway: isDark ? '#333333' : '#dfdfdf',
    water,
    zoo: isDark ? '#181818' : '#ededed',
    military: isDark ? '#191919' : '#eaeaea',
    tunnel_other_casing: tunnelCasing,
    tunnel_minor_casing: tunnelCasing,
    tunnel_link_casing: tunnelCasing,
    tunnel_major_casing: tunnelCasing,
    tunnel_highway_casing: tunnelCasing,
    tunnel_other: isDark ? tunnelFill : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    tunnel_minor: isDark ? tunnelFill : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    tunnel_link: isDark ? tunnelFill : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    tunnel_major: isDark ? '#383838' : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    tunnel_highway: isDark ? '#454545' : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    pier: isDark ? '#242424' : '#e5e5e5',
    buildings: buildingFill,
    minor_service_casing: roadCasing,
    minor_casing: roadCasing,
    link_casing: roadCasing,
    major_casing_late: roadCasingWide,
    highway_casing_late: roadCasingWide,
    other: roadFill,
    minor_service: isDark ? '#363636' : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    minor_a: isDark ? '#3b3b3b' : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    minor_b: roadFillWide,
    link: roadFillWide,
    major_casing_early: roadCasingWide,
    major: isDark ? '#565656' : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    highway_casing_early: roadCasingWide,
    highway: isDark ? '#636363' : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    railway: isDark ? '#575757' : '#919191',
    boundaries: boundaryColor,
    bridges_other_casing: bridgeCasing,
    bridges_minor_casing: bridgeCasing,
    bridges_link_casing: bridgeCasing,
    bridges_major_casing: bridgeCasing,
    bridges_highway_casing: bridgeCasing,
    bridges_other: isDark ? '#313131' : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    bridges_minor: isDark ? bridgeFill : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    bridges_link: isDark ? bridgeFill : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    bridges_major: isDark ? '#4e4e4e' : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    bridges_highway: isDark ? '#5b5b5b' : CUSTOM_BASEMAP_LIGHT_ROAD_COLOR,
    roads_label_minor: labelSecondary,
    roads_label_minor_halo: labelHalo,
    roads_label_major: labelPrimary,
    roads_label_major_halo: labelHalo,
    ocean_label: isDark ? '#bcbcbc' : '#626262',
    subplace_label: labelSecondary,
    subplace_label_halo: labelHalo,
    city_label: isDark ? '#f0f0f0' : '#494949',
    city_label_halo: labelHalo,
    state_label: labelTertiary,
    state_label_halo: labelHalo,
    country_label: isDark ? '#bbbbbb' : '#727272',
    address_label: isDark ? '#dddddd' : '#5b5b5b',
    address_label_halo: labelHalo,
    pois: undefined,
    landcover: buildMonochromeLandcoverPalette(theme)
  };
}

function shouldHideCustomBasemapLayer(layer) {
  if (!layer || typeof layer !== 'object') return false;
  const id = String(layer.id || '').trim().toLowerCase();
  if (id === 'pois' || id.startsWith('pois-')) return true;
  if (String(layer?.['source-layer'] || '').trim().toLowerCase() === 'pois') return true;
  return false;
}

function transformCustomBasemapStyle(style, theme = 'light') {
  const nextStyle = cloneMapStyle(style);
  const nextLayers = Array.isArray(nextStyle?.layers) ? nextStyle.layers : [];
  const normalizedTheme = normalizeThemeVariant(theme);

  for (const layer of nextLayers) {
    if (!shouldHideCustomBasemapLayer(layer)) continue;
    layer.layout = {
      ...(layer.layout && typeof layer.layout === 'object' ? layer.layout : {}),
      visibility: 'none'
    };
  }

  if (normalizedTheme === 'light') {
    const landuseParkIndex = nextLayers.findIndex((layer) => layer?.id === 'landuse_park');
    const detailedRoadLayerIds = new Set([
      'roads_other',
      'roads_minor_service',
      'roads_minor',
      'roads_minor_casing',
      'roads_tunnels_other',
      'roads_tunnels_minor',
      'roads_tunnels_minor_casing',
      'roads_bridges_other',
      'roads_bridges_minor',
      'roads_bridges_minor_casing'
    ]);
    if (landuseParkIndex >= 0) {
      const landuseParkLayer = nextLayers[landuseParkIndex];
      landuseParkLayer.filter = [
        'all',
        Array.isArray(landuseParkLayer.filter) ? landuseParkLayer.filter : ['in', 'kind', 'park'],
        ['!in', 'kind', 'park', 'grassland', 'grass', 'wood', 'scrub']
      ];
      const extraLanduseLayers = buildCustomBasemapLanduseDetailLayers(normalizedTheme);
      if (extraLanduseLayers.length > 0) {
        nextLayers.splice(landuseParkIndex + 1, 0, ...extraLanduseLayers);
      }
    }
    const pedestrianInsertIndex = [
      'roads_tunnels_other_casing',
      'roads_other',
      'roads_runway'
    ]
      .map((layerId) => nextLayers.findIndex((layer) => layer?.id === layerId))
      .find((index) => index >= 0);
    const landusePedestrianLayer = nextLayers.find((layer) => layer?.id === 'landuse_pedestrian');
    if (landusePedestrianLayer) {
      landusePedestrianLayer.filter = [
        'all',
        Array.isArray(landusePedestrianLayer.filter) ? landusePedestrianLayer.filter : ['in', 'kind', 'pedestrian', 'dam'],
        ['!in', 'kind', 'pedestrian']
      ];
      const extraLanduseLayers = buildCustomBasemapPedestrianDetailLayers(normalizedTheme);
      if (extraLanduseLayers.length > 0 && pedestrianInsertIndex != null) {
        // Keep pedestrian landuse above water/vegetation fills, but below the road stack.
        nextLayers.splice(pedestrianInsertIndex, 0, ...extraLanduseLayers);
      }
    }
    const roadsRailIndex = nextLayers.findIndex((layer) => layer?.id === 'roads_rail');
    for (const layer of nextLayers) {
      if (!layer || typeof layer !== 'object') continue;
      if (!detailedRoadLayerIds.has(String(layer.id || ''))) continue;
      layer.filter = [
        ...(Array.isArray(layer.filter) ? layer.filter : []),
        ['!in', 'kind_detail', ...CUSTOM_BASEMAP_DETAILED_KIND_VALUES]
      ];
    }
    if (roadsRailIndex >= 0) {
      const roadsRailLayer = nextLayers[roadsRailIndex];
      roadsRailLayer.layout = {
        ...(roadsRailLayer.layout && typeof roadsRailLayer.layout === 'object' ? roadsRailLayer.layout : {}),
        'line-cap': 'butt',
        'line-join': 'round'
      };
      roadsRailLayer.paint = {
        ...(roadsRailLayer.paint && typeof roadsRailLayer.paint === 'object' ? roadsRailLayer.paint : {}),
        'line-color': CUSTOM_BASEMAP_LIGHT_RAIL_OUTER_COLOR,
        'line-opacity': 0.95,
        'line-width': CUSTOM_BASEMAP_LIGHT_RAIL_OUTER_WIDTH
      };
      roadsRailLayer.filter = [
        'all',
        Array.isArray(roadsRailLayer.filter) ? roadsRailLayer.filter : ['==', 'kind', 'rail'],
        ['!in', 'kind_detail', ...CUSTOM_BASEMAP_SOLID_TRANSIT_KIND_VALUES],
        ['!=', 'kind_detail', 'subway']
      ];
      delete roadsRailLayer.paint['line-dasharray'];
      const extraLayers = buildCustomBasemapRoadDetailLayers(normalizedTheme);
      if (extraLayers.length > 0) {
        nextLayers.splice(roadsRailIndex + 1, 0, ...extraLayers);
      }
    }
  }

  return nextStyle;
}

function getCustomBasemapStyleCacheKey(theme, localeCode, sourceUrl) {
  const normalizedTheme = normalizeThemeVariant(theme);
  const normalizedLocale = normalizeMapLabelLocale(localeCode);
  return `${normalizedTheme}|${normalizedLocale}|${String(sourceUrl || '')}`;
}

function buildCustomBasemapStyle(theme, localeCode = 'en', runtimeConfig = getRuntimeConfig()) {
  const sourceSignature = buildBasemapSourceUrl(getCustomBasemapUrl(runtimeConfig), getCustomBasemapApiKey(runtimeConfig));
  const cacheKey = getCustomBasemapStyleCacheKey(theme, localeCode, sourceSignature);
  let cachedStyle = CUSTOM_STYLE_CACHE.get(cacheKey);
  if (!cachedStyle) {
    const normalizedTheme = normalizeThemeVariant(theme);
    const normalizedLocale = normalizeMapLabelLocale(localeCode);
    cachedStyle = transformCustomBasemapStyle({
      version: 8,
      sources: {
        protomaps: {
          type: 'vector',
          attribution: '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://osm.org/copyright">OpenStreetMap</a>',
          url: resolveSameOriginUrl(CUSTOM_BASEMAP_TILEJSON_PROXY_URL)
        }
      },
      layers: layers('protomaps', buildCustomBasemapFlavor(normalizedTheme), {
        lang: normalizedLocale
      }),
      glyphs: resolveSameOriginUrl(PROTOMAPS_GLYPHS_PROXY_URL),
      sprite: resolveSameOriginUrl(buildProtomapsSpriteProxyUrl(normalizedTheme))
    }, normalizedTheme);
    CUSTOM_STYLE_CACHE.set(cacheKey, cachedStyle);
  }

  return cloneMapStyle(cachedStyle);
}

function cloneMapStyle(value) {
  if (typeof globalThis?.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  if (value && typeof value === 'object') {
    return JSON.parse(JSON.stringify(value));
  }
  return value;
}

function isNameToken(token) {
  return token === 'name' || token === 'name:en' || token === 'name:ru';
}

function isNameGetExpression(value) {
  return Array.isArray(value) && value[0] === 'get' && isNameToken(String(value[1] || ''));
}

function isLocalizableNameExpression(value) {
  if (!Array.isArray(value)) return false;
  if (isNameGetExpression(value)) return true;
  return value[0] === 'coalesce' && value.slice(1).length > 0 && value.slice(1).every(isNameGetExpression);
}

function buildLocalizedNameExpression(localeCode) {
  const normalizedLocale = normalizeMapLabelLocale(localeCode);
  if (normalizedLocale === 'ru') {
    return ['coalesce', ['get', 'name:ru'], ['get', 'name'], ['get', 'name:en']];
  }
  return ['coalesce', ['get', 'name:en'], ['get', 'name']];
}

function buildDynamicTextExpression(parts = []) {
  const filteredParts = parts.filter((part) => part !== '');
  if (filteredParts.length === 0) return '';
  if (filteredParts.length === 1) return filteredParts[0];
  return ['concat', ...filteredParts];
}

function localizeTokenTemplate(value, localeCode, { forceDynamicTokens = false } = {}) {
  if (typeof value !== 'string') return value;

  const tokenPattern = /\{([^}]+)\}/g;
  const matches = [...value.matchAll(tokenPattern)];
  if (matches.length === 0) return value;

  const hasNameToken = matches.some((match) => isNameToken(String(match[1] || '').trim()));
  if (!hasNameToken && !forceDynamicTokens) {
    return value;
  }

  const parts = [];
  let lastIndex = 0;
  for (const match of matches) {
    const fullMatch = String(match[0] || '');
    const token = String(match[1] || '').trim();
    const matchIndex = Number(match.index || 0);
    const literalPart = value.slice(lastIndex, matchIndex);
    if (literalPart) {
      parts.push(literalPart);
    }
    parts.push(
      isNameToken(token)
        ? buildLocalizedNameExpression(localeCode)
        : ['coalesce', ['get', token], '']
    );
    lastIndex = matchIndex + fullMatch.length;
  }
  const tail = value.slice(lastIndex);
  if (tail) {
    parts.push(tail);
  }
  return buildDynamicTextExpression(parts);
}

function convertTextFunctionToExpression(value, localeCode) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.property != null) {
    return value;
  }
  const stops = Array.isArray(value.stops) ? value.stops : [];
  if (stops.length === 0) return value;

  const initialValue = localizeTextFieldValue(stops[0]?.[1], localeCode, {
    forceDynamicTokens: true
  });
  const expression = ['step', ['zoom'], initialValue];
  for (let index = 1; index < stops.length; index += 1) {
    const stop = stops[index];
    const zoom = Number(stop?.[0]);
    if (!Number.isFinite(zoom)) {
      return value;
    }
    expression.push(
      zoom,
      localizeTextFieldValue(stop?.[1], localeCode, {
        forceDynamicTokens: true
      })
    );
  }
  return expression;
}

function localizeTextFieldValue(value, localeCode, { forceDynamicTokens = false } = {}) {
  if (typeof value === 'string') {
    return localizeTokenTemplate(value, localeCode, { forceDynamicTokens });
  }
  if (isLocalizableNameExpression(value)) {
    return buildLocalizedNameExpression(localeCode);
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.stops)) {
    return convertTextFunctionToExpression(value, localeCode);
  }
  return value;
}

function shouldHideMapTilerLayer(layer) {
  if (!layer || typeof layer !== 'object') return false;
  if (layer.type === 'fill-extrusion') return true;
  if (layer['source-layer'] === 'poi') return true;
  if (hasPositiveStyleFilterMatch(layer.filter, 'class', 'ferry')) return true;
  return false;
}

export function normalizeMapLabelLocale(localeCode) {
  const normalized = String(localeCode || '').trim().toLowerCase();
  return normalized.startsWith('ru') ? 'ru' : 'en';
}

export function getMapStyleForTheme(theme, runtimeConfig = getRuntimeConfig(), localeCode = 'en') {
  const basemapProvider = getBasemapProvider(runtimeConfig);
  const maptilerApiKey = getMapTilerApiKey(runtimeConfig);
  if (basemapProvider === 'maptiler' && maptilerApiKey) {
    return buildMapTilerStyleUrl(
      theme === 'dark' ? MAPTILER_DARK_STYLE_ID : MAPTILER_LIGHT_STYLE_ID,
      maptilerApiKey
    );
  }
  if (basemapProvider === 'custom' && getCustomBasemapUrl(runtimeConfig)) {
    return buildCustomBasemapStyle(theme, localeCode, runtimeConfig);
  }
  return theme === 'dark' ? DARK_MAP_STYLE_URL : LIGHT_MAP_STYLE_URL;
}

export function getMapStyleSignature(theme, runtimeConfig = getRuntimeConfig(), localeCode = 'en') {
  const basemapProvider = getBasemapProvider(runtimeConfig);
  const normalizedLocale = normalizeMapLabelLocale(localeCode);
  if (basemapProvider === 'maptiler' && getMapTilerApiKey(runtimeConfig)) {
    const style = getMapStyleForTheme(theme, runtimeConfig);
    return `${String(style)}|${normalizedLocale}`;
  }
  if (basemapProvider === 'custom' && getCustomBasemapUrl(runtimeConfig)) {
    return [
      'custom',
      normalizeThemeVariant(theme),
      normalizedLocale,
      getCustomBasemapUrl(runtimeConfig),
      getCustomBasemapApiKey(runtimeConfig)
    ].join('|');
  }
  return String(getMapStyleForTheme(theme, runtimeConfig));
}

export function transformMapTilerStyle(style, { localeCode = 'en' } = {}) {
  const normalizedLocale = normalizeMapLabelLocale(localeCode);
  const nextStyle = cloneMapStyle(style);
  const nextLayers = Array.isArray(nextStyle?.layers) ? nextStyle.layers : [];

  for (const layer of nextLayers) {
    if (!layer || typeof layer !== 'object') continue;

    if (shouldHideMapTilerLayer(layer)) {
      layer.layout = {
        ...(layer.layout && typeof layer.layout === 'object' ? layer.layout : {}),
        visibility: 'none'
      };
    }

    const textField = layer?.layout?.['text-field'];
    if (textField == null) continue;

    const localizedTextField = localizeTextFieldValue(textField, normalizedLocale);
    if (localizedTextField === textField) continue;

    layer.layout = {
      ...(layer.layout && typeof layer.layout === 'object' ? layer.layout : {}),
      'text-field': localizedTextField
    };
  }

  return nextStyle;
}

async function loadMapTilerStyle(url, localeCode, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('MapTiler style fetch is unavailable');
  }

  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json'
    }
  });
  if (!response?.ok) {
    throw new Error(`MapTiler style request failed with status ${Number(response?.status) || 0}`);
  }

  const style = await response.json();
  return transformMapTilerStyle(style, { localeCode });
}

export async function resolveMapStyleForTheme(
  theme,
  {
    runtimeConfig = getRuntimeConfig(),
    localeCode = 'en',
    fetchImpl = globalThis.fetch
  } = {}
) {
  const style = getMapStyleForTheme(theme, runtimeConfig, localeCode);
  const basemapProvider = getBasemapProvider(runtimeConfig);
  const maptilerApiKey = getMapTilerApiKey(runtimeConfig);
  if (basemapProvider !== 'maptiler' || !maptilerApiKey) {
    return cloneMapStyle(style);
  }

  const cacheKey = `${String(style)}|${normalizeMapLabelLocale(localeCode)}`;
  let pendingStyle = MAPTILER_STYLE_CACHE.get(cacheKey);
  if (!pendingStyle) {
    pendingStyle = loadMapTilerStyle(style, localeCode, fetchImpl).catch((error) => {
      MAPTILER_STYLE_CACHE.delete(cacheKey);
      console.warn('[map-style] Falling back to direct MapTiler style URL', error);
      return style;
    });
    MAPTILER_STYLE_CACHE.set(cacheKey, pendingStyle);
  }

  const resolvedStyle = await pendingStyle;
  return cloneMapStyle(resolvedStyle);
}

export function getBuildingThemePaint(theme) {
  return theme === 'dark' ? BUILDING_THEME.dark : BUILDING_THEME.light;
}

export function getBuildingHoverThemePaint(theme) {
  return theme === 'dark' ? BUILDING_HOVER_THEME.dark : BUILDING_HOVER_THEME.light;
}
