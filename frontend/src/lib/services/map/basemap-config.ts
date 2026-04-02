export const DEFAULT_CUSTOM_BASEMAP_URL = '';
export const CUSTOM_BASEMAP_TILEJSON_PROXY_URL = '/api/basemaps/custom/current.json';
export const CUSTOM_BASEMAP_TILE_PROXY_URL = '/api/basemaps/custom/tiles';
export const PROTOMAPS_GLYPHS_PROXY_URL = '/basemaps-assets/fonts/{fontstack}/{range}.pbf';
const PROTOMAPS_SPRITES_LOCAL_BASE_URL = '/basemaps-assets/sprites/v4';

export function normalizeBasemapThemeVariant(value) {
  return String(value || '').trim().toLowerCase() === 'dark' ? 'dark' : 'light';
}

export function normalizeBasemapProvider(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'maptiler') return 'maptiler';
  if (text === 'custom' || text === 'pmtiles' || text === 'protomaps') return 'custom';
  return 'carto';
}

export function normalizeCustomBasemapUrl(value, fallback = DEFAULT_CUSTOM_BASEMAP_URL) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;

  const candidates = [text];
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
    candidates.push(`http://${text}`);
  }

  for (const candidate of candidates) {
    try {
      return new URL(candidate).toString();
    } catch {
      // try the next candidate
    }
  }

  return fallback;
}

export function normalizeBasemapApiKey(value) {
  return String(value ?? '').trim();
}

export function buildBasemapSourceUrl(url, apiKey) {
  const sourceUrl = normalizeCustomBasemapUrl(url);
  if (!sourceUrl) return '';
  const key = normalizeBasemapApiKey(apiKey);
  if (!key) return sourceUrl;
  const nextUrl = new URL(sourceUrl);
  nextUrl.searchParams.set('key', key);
  return nextUrl.toString();
}

export function buildProtomapsSpriteProxyUrl(theme) {
  return `${PROTOMAPS_SPRITES_LOCAL_BASE_URL}/${normalizeBasemapThemeVariant(theme)}`;
}
