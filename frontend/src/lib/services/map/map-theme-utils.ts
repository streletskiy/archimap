import { getRuntimeConfig } from '../config.js';
import { hasPositiveStyleFilterMatch } from './map-style-filter-utils.js';

export const LIGHT_MAP_STYLE_URL = '/styles/positron-custom.json';
export const DARK_MAP_STYLE_URL = '/styles/dark-matter-custom.json';
export const STYLE_OVERLAY_FADE_MS = 260;
export const MAPTILER_LIGHT_STYLE_ID = 'streets-v2-light';
export const MAPTILER_DARK_STYLE_ID = 'streets-v2-dark';
const MAPTILER_STYLE_CACHE = new Map();

export const BUILDING_THEME = Object.freeze({
  light: {
    fillColor: '#dededc',
    fillOpacity: 1,
    lineColor: '#bcbcbc',
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
  return String(runtimeConfig?.basemap?.provider || '').trim().toLowerCase();
}

function getMapTilerApiKey(runtimeConfig = getRuntimeConfig()) {
  return String(runtimeConfig?.basemap?.maptilerApiKey || '').trim();
}

function buildMapTilerStyleUrl(styleId, apiKey) {
  return `https://api.maptiler.com/maps/${styleId}/style.json?key=${encodeURIComponent(apiKey)}`;
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

export function getMapStyleForTheme(theme, runtimeConfig = getRuntimeConfig()) {
  const basemapProvider = getBasemapProvider(runtimeConfig);
  const maptilerApiKey = getMapTilerApiKey(runtimeConfig);
  if (basemapProvider === 'maptiler' && maptilerApiKey) {
    return buildMapTilerStyleUrl(
      theme === 'dark' ? MAPTILER_DARK_STYLE_ID : MAPTILER_LIGHT_STYLE_ID,
      maptilerApiKey
    );
  }
  return theme === 'dark' ? DARK_MAP_STYLE_URL : LIGHT_MAP_STYLE_URL;
}

export function getMapStyleSignature(theme, runtimeConfig = getRuntimeConfig(), localeCode = 'en') {
  const style = getMapStyleForTheme(theme, runtimeConfig);
  const basemapProvider = getBasemapProvider(runtimeConfig);
  if (basemapProvider === 'maptiler' && getMapTilerApiKey(runtimeConfig)) {
    return `${String(style)}|${normalizeMapLabelLocale(localeCode)}`;
  }
  return String(style);
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
  const style = getMapStyleForTheme(theme, runtimeConfig);
  const basemapProvider = getBasemapProvider(runtimeConfig);
  const maptilerApiKey = getMapTilerApiKey(runtimeConfig);
  if (basemapProvider !== 'maptiler' || !maptilerApiKey) {
    return style;
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
