function readViewFromUrl() {
  const hash = String(window.location.hash || '');
  const match = hash.match(/^#map=(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;

  const zoom = Number(match[1]);
  const lat = Number(match[2]);
  const lon = Number(match[3]);
  if ([zoom, lat, lon].some((n) => Number.isNaN(n))) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { zoom, center: [lon, lat] };
}

function saveLastMapHash(hashValue) {
  const text = String(hashValue || '').trim();
  if (!text.startsWith('#map=')) return;
  try {
    localStorage.setItem('archimap-last-map-hash', text);
  } catch {
    // ignore
  }
}

function writeViewToUrl() {
  const center = map.getCenter();
  const zoom = map.getZoom();
  const nextHash = `#map=${zoom.toFixed(2)}/${center.lat.toFixed(6)}/${center.lng.toFixed(6)}`;
  saveLastMapHash(nextHash);
  if (window.location.hash !== nextHash) {
    const url = new URL(window.location.href);
    url.hash = nextHash;
    history.replaceState(null, '', url.toString());
  }
}

function readBuildingFromUrl() {
  const url = new URL(window.location.href);
  const raw = url.searchParams.get('b');
  if (!raw) return null;
  const parsed = parseKey(raw);
  return parsed || null;
}

function writeBuildingToUrl(osmType, osmId, options = {}) {
  const mode = options.mode === 'replace' ? 'replace' : 'push';
  const nextValue = `${osmType}/${osmId}`;
  const url = new URL(window.location.href);
  if (url.searchParams.get('b') === nextValue) return;
  url.searchParams.set('b', nextValue);
  if (mode === 'replace') {
    history.replaceState(null, '', url.toString());
    return;
  }
  history.pushState(null, '', url.toString());
}

function clearBuildingFromUrl(options = {}) {
  const mode = options.mode === 'replace' ? 'replace' : 'push';
  const url = new URL(window.location.href);
  if (!url.searchParams.has('b')) return;
  url.searchParams.delete('b');
  if (mode === 'replace') {
    history.replaceState(null, '', url.toString());
    return;
  }
  history.pushState(null, '', url.toString());
}

function readRequestedPostLoginPath() {
  try {
    const url = new URL(window.location.href);
    const raw = String(url.searchParams.get('next') || '').trim();
    if (!raw) return null;
    if (!raw.startsWith('/')) return null;
    if (raw.startsWith('//')) return null;
    if (raw.includes('://')) return null;
    return raw;
  } catch {
    return null;
  }
}

function shouldOpenAuthFromUrl() {
  try {
    const url = new URL(window.location.href);
    return String(url.searchParams.get('auth') || '') === '1';
  } catch {
    return false;
  }
}

const initialView = readViewFromUrl();
const LIGHT_MAP_STYLE_URL = '/styles/positron-custom.json';
const DARK_MAP_STYLE_URL = '/styles/dark-matter-custom.json';
let currentMapTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
const FALLBACK_DEFAULT_MAP_VIEW = Object.freeze({
  center: [44.0059, 56.3269],
  zoom: 15
});

function getDefaultMapView() {
  const cfg = window.__ARCHIMAP_CONFIG?.mapDefault;
  const lon = Number(cfg?.lon);
  const lat = Number(cfg?.lat);
  const zoom = Number(cfg?.zoom);

  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(zoom)) {
    return FALLBACK_DEFAULT_MAP_VIEW;
  }
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90 || zoom < 0 || zoom > 22) {
    return FALLBACK_DEFAULT_MAP_VIEW;
  }

  return {
    center: [lon, lat],
    zoom
  };
}

const defaultMapView = getDefaultMapView();
const PMTILES_CONFIG = Object.freeze({
  url: String(window.__ARCHIMAP_CONFIG?.buildingsPmtiles?.url || '/api/buildings.pmtiles'),
  sourceLayer: String(window.__ARCHIMAP_CONFIG?.buildingsPmtiles?.sourceLayer || 'buildings')
});
const BUILD_INFO_CONFIG = Object.freeze({
  shortSha: String(window.__ARCHIMAP_CONFIG?.buildInfo?.shortSha || 'unknown').trim() || 'unknown',
  version: String(window.__ARCHIMAP_CONFIG?.buildInfo?.version || 'dev').trim() || 'dev',
  repoUrl: String(window.__ARCHIMAP_CONFIG?.buildInfo?.repoUrl || 'https://github.com/streletskiy/archimap').trim() || 'https://github.com/streletskiy/archimap'
});
const AUTH_CONFIG = Object.freeze({
  registrationEnabled: Boolean(window.__ARCHIMAP_CONFIG?.auth?.registrationEnabled ?? true),
  bootstrapFirstAdminAvailable: Boolean(window.__ARCHIMAP_CONFIG?.auth?.bootstrapFirstAdminAvailable ?? false)
});
const LOCAL_BUILDING_STYLE_FALLBACK = Object.freeze({
  light: Object.freeze({
    fill: Object.freeze({
      normal: '#a3a3a3',
      filtered: '#12b4a6',
      hoverNormal: '#8f8f8f',
      hoverFiltered: '#0f9e92',
      opacityNormal: 0.36,
      opacityActive: 0.82,
      opacityHover: 0.58
    }),
    line: Object.freeze({
      normal: '#bcbcbc',
      filtered: '#0b6d67',
      hoverNormal: '#9a9a9a',
      hoverFiltered: '#0a7770',
      widthNormal: 0.9,
      widthFiltered: 1.4,
      widthHover: 1.8
    }),
    transition: Object.freeze({
      durationMs: 180
    })
  }),
  dark: Object.freeze({
    fill: Object.freeze({
      normal: '#a3a3a3',
      filtered: '#12b4a6',
      hoverNormal: '#b8b8b8',
      hoverFiltered: '#2ac8ba',
      opacityNormal: 0.36,
      opacityActive: 0.82,
      opacityHover: 0.58
    }),
    line: Object.freeze({
      normal: '#8f8f8f',
      filtered: '#0b6d67',
      hoverNormal: '#a8a8a8',
      hoverFiltered: '#79dfd6',
      widthNormal: 0.9,
      widthFiltered: 1.4,
      widthHover: 1.8
    }),
    transition: Object.freeze({
      durationMs: 180
    })
  })
});

function getMapStyleForTheme(theme) {
  return theme === 'dark' ? DARK_MAP_STYLE_URL : LIGHT_MAP_STYLE_URL;
}

function getLocalBuildingStyleForTheme(theme) {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  const external = window.__ARCHIMAP_LOCAL_BUILDING_STYLE;
  if (external && typeof external === 'object' && external[normalized]) {
    return external[normalized];
  }
  return LOCAL_BUILDING_STYLE_FALLBACK[normalized];
}

const pmtilesProtocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);

const map = new maplibregl.Map({
  container: 'map',
  style: getMapStyleForTheme(currentMapTheme),
  center: initialView ? initialView.center : defaultMapView.center,
  zoom: initialView ? initialView.zoom : defaultMapView.zoom,
  attributionControl: true
});

const MIN_BUILDING_ZOOM = 13;
const CARTO_BUILDINGS_SOURCE_ID = 'carto';
const CARTO_BUILDINGS_SOURCE_LAYER = 'building';

map.addControl(new maplibregl.NavigationControl(), 'top-right');

let selected = null;
let urlSelectionSyncSeq = 0;
let isAuthenticated = false;
let isAdmin = false;
let isMasterAdmin = false;
let currentUser = null;
let canEditBuildings = false;
let loadTimer = null;
let currentBuildingsGeojson = { type: 'FeatureCollection', features: [] };
let filterRowSeq = 0;
const localEditStateOverrides = new Map();
let currentVisibleBuildingKeys = new Set();
let lastCartoBuildingsVisibility = null;
let hoveredBuildingKey = null;
let dbFilterTagKeys = [];
let dbFilterTagKeysLoaded = false;
let dbFilterTagKeysLoadingPromise = null;
let dbFilterTagKeysRetryTimer = null;
let lastRenderedFilterTagKeysSignature = '';
let visibleBuildingsLoadSeq = 0;
const filterDataCache = new Map();
const filterFeatureStateCache = new Map();
const FILTER_DATA_CACHE_TTL_MS = 10 * 60 * 1000;
const FILTER_DATA_CACHE_MAX_ITEMS = 60000;
const FILTER_PREFETCH_PADDING_RATIO = 0.35;
const FILTER_PREFETCH_LIMIT = 15000;
const filterPrefetchInFlight = new Map();

const authStatusEl = document.getElementById('auth-status');
const logoutBtn = document.getElementById('logout-btn');
const loginForm = document.getElementById('login-form');
const loginUsernameEl = document.getElementById('login-username');
const authTabLoginEl = document.getElementById('auth-tab-login');
const authTabRegisterEl = document.getElementById('auth-tab-register');
const forgotPasswordToggleEl = document.getElementById('forgot-password-toggle');
const authLoginPanelEl = document.getElementById('auth-login-panel');
const registerPanelEl = document.getElementById('register-panel');
const registerFormEl = document.getElementById('register-form');
const registerFirstNameEl = document.getElementById('register-first-name');
const registerLastNameEl = document.getElementById('register-last-name');
const registerEmailEl = document.getElementById('register-email');
const registerPasswordEl = document.getElementById('register-password');
const registerPasswordConfirmEl = document.getElementById('register-password-confirm');
const registerStatusEl = document.getElementById('register-status');
const forgotPasswordPanelEl = document.getElementById('forgot-password-panel');
const forgotPasswordFormEl = document.getElementById('forgot-password-form');
const forgotPasswordEmailEl = document.getElementById('forgot-password-email');
const forgotPasswordStatusEl = document.getElementById('forgot-password-status');
const resetPasswordPanelEl = document.getElementById('reset-password-panel');
const resetPasswordFormEl = document.getElementById('reset-password-form');
const resetPasswordNewEl = document.getElementById('reset-password-new');
const resetPasswordConfirmEl = document.getElementById('reset-password-confirm');
const resetPasswordStatusEl = document.getElementById('reset-password-status');
const registerVerifyPanelEl = document.getElementById('register-verify-panel');
const registerVerifyHintEl = document.getElementById('register-verify-hint');
const registerVerifyFormEl = document.getElementById('register-verify-form');
const registerVerifyCodeEl = document.getElementById('register-verify-code');
const registerVerifyStatusEl = document.getElementById('register-verify-status');
const filterToggleBtnEl = document.getElementById('filter-toggle-btn');
const filterShellEl = document.getElementById('filter-shell');
const mobileControlsToggleBtnEl = document.getElementById('mobile-controls-toggle-btn');
const mobileControlsShellEl = document.getElementById('mobile-controls-shell');
const filterCloseBtnEl = document.getElementById('filter-close-btn');
const filterRowsEl = document.getElementById('filter-rows');
const filterAddRowBtnEl = document.getElementById('filter-add-row-btn');
const filterResetBtnEl = document.getElementById('filter-reset-btn');
const filterStatusEl = document.getElementById('filter-status');
const filterTagKeysEl = document.getElementById('filter-tag-keys');
const labelsToggleEl = document.getElementById('labels-toggle');
const themeToggleEl = document.getElementById('theme-toggle');

const modalEl = document.getElementById('building-modal');
const modalContentEl = document.getElementById('modal-content');
const modalCloseBtn = document.getElementById('modal-close');
const authFabEl = document.getElementById('auth-fab');
const adminLinkEl = document.getElementById('admin-link');
const uiKitLinkEl = document.getElementById('ui-kit-link');
const settingsLogoutBtnEl = document.getElementById('settings-logout-btn');
const authModalEl = document.getElementById('auth-modal');
const authModalCloseEl = document.getElementById('auth-modal-close');
const profileModalEl = document.getElementById('profile-modal');
const profileModalCloseEl = document.getElementById('profile-modal-close');
const profileEmailEl = document.getElementById('profile-email');
const profileFormEl = document.getElementById('profile-form');
const profileFirstNameEl = document.getElementById('profile-first-name');
const profileLastNameEl = document.getElementById('profile-last-name');
const profileStatusEl = document.getElementById('profile-status');
const changePasswordFormEl = document.getElementById('change-password-form');
const changePasswordStatusEl = document.getElementById('change-password-status');
const profileLogoutBtnEl = document.getElementById('profile-logout-btn');
const searchFormEl = document.getElementById('search-form');
const searchInputEl = document.getElementById('search-input');
const searchMobileBtnEl = document.getElementById('search-mobile-btn');
const searchModalEl = document.getElementById('search-modal');
const searchModalCloseEl = document.getElementById('search-modal-close');
const searchModalFormEl = document.getElementById('search-modal-form');
const searchModalInputEl = document.getElementById('search-modal-input');
const searchResultsStatusEl = document.getElementById('search-results-status');
const searchResultsListEl = document.getElementById('search-results-list');
const searchLoadMoreBtnEl = document.getElementById('search-load-more-btn');
const settingsBuildLinkEl = document.getElementById('settings-build-link');
const settingsBuildTextEl = document.getElementById('settings-build-text');
const navLogoLinkEl = document.getElementById('nav-logo-link');
const THEME_STORAGE_KEY = 'archimap-theme';
const LABELS_HIDDEN_STORAGE_KEY = 'archimap-labels-hidden';
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_RESULTS_LIMIT = 30;
const SEARCH_RESULTS_SOURCE_ID = 'search-results-points';
const SEARCH_RESULTS_LAYER_ID = 'search-results-points-layer';
const SEARCH_RESULTS_CLUSTER_LAYER_ID = 'search-results-clusters-layer';
const SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID = 'search-results-clusters-count-layer';
const buildingSearchCache = new Map();
let activeSearchRequestToken = 0;
let searchState = {
  query: '',
  center: null,
  items: [],
  hasMore: false,
  nextCursor: null
};
let searchMarkersGeojson = { type: 'FeatureCollection', features: [] };
let pendingResetToken = null;
let pendingRegisterToken = null;
let pendingRegistrationEmail = null;
let csrfToken = null;
pendingResetToken = readResetTokenFromUrl();
pendingRegisterToken = readRegisterTokenFromUrl();
saveLastMapHash(window.location.hash);

if (navLogoLinkEl) {
  navLogoLinkEl.addEventListener('click', (event) => {
    event.preventDefault();
    const hash = String(window.location.hash || '').trim();
    const target = hash.startsWith('#map=') ? `/${hash}` : '/';
    window.location.href = target;
  });
}

const nativeFetch = window.fetch.bind(window);

function isStateChangingMethod(method) {
  const m = String(method || 'GET').toUpperCase();
  return !['GET', 'HEAD', 'OPTIONS'].includes(m);
}

function isSameOriginRequest(input) {
  try {
    if (typeof input === 'string') {
      if (input.startsWith('http://') || input.startsWith('https://')) {
        return new URL(input).origin === window.location.origin;
      }
      return true;
    }
    if (input && typeof input.url === 'string') {
      return new URL(input.url, window.location.origin).origin === window.location.origin;
    }
  } catch {
    return false;
  }
  return false;
}

window.fetch = (input, init = {}) => {
  const nextInit = { ...init };
  const method = String(nextInit.method || (input?.method || 'GET')).toUpperCase();
  if (csrfToken && isStateChangingMethod(method) && isSameOriginRequest(input)) {
    const headers = new Headers(nextInit.headers || {});
    if (!headers.has('x-csrf-token')) {
      headers.set('x-csrf-token', csrfToken);
    }
    nextInit.headers = headers;
  }
  return nativeFetch(input, nextInit);
};

const I18N_RU = window.__ARCHIMAP_I18N_RU || {};
const UI_TEXT = Object.freeze(I18N_RU.ui || {});

function t(key, params = null, fallback = '') {
  const template = Object.prototype.hasOwnProperty.call(UI_TEXT, key) ? UI_TEXT[key] : fallback;
  const base = String(template || fallback || '');
  if (!params || typeof params !== 'object') return base;
  return base.replace(/\{(\w+)\}/g, (_, name) => (params[name] == null ? '' : String(params[name])));
}

const OSM_FILTER_TAG_LABELS_RU = Object.freeze(I18N_RU.filterTagLabels || {});

const PRIORITY_FILTER_TAG_KEYS = Object.freeze([
  'architect',
  'building:architecture',
  'style',
  'year_built',
  'year_of_construction',
  'start_date',
  'building:start_date',
  'building:year',
  'building:levels',
  'levels'
]);

const APPEARANCE_FILTER_TAG_KEYS = Object.freeze([
  'building:colour',
  'building:material',
  'building:height',
  'roof:colour',
  'roof:shape',
  'roof:levels',
  'roof:orientation',
  'height',
  'colour',
  'material'
]);

const APPEARANCE_FILTER_TAG_PREFIXES = Object.freeze([
  'roof:',
  'facade:',
  'building:facade',
  'building:cladding',
  'building:colour',
  'building:material',
  'building:height',
  'building:shape'
]);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getSavedTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // ignore localStorage access failures
  }
  return null;
}

function getSystemTheme() {
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function getCurrentTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'dark' ? 'dark' : 'light';
}

function getSavedLabelsHidden() {
  try {
    const stored = localStorage.getItem(LABELS_HIDDEN_STORAGE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch {
    // ignore localStorage access failures
  }
  return null;
}

function applyTheme(theme, options = {}) {
  const { persist = true } = options;
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', normalized);
  applyMapTheme(normalized);

  if (themeToggleEl) {
    themeToggleEl.checked = normalized === 'dark';
    themeToggleEl.setAttribute(
      'aria-label',
      normalized === 'dark'
        ? t('themeEnableLight', null, 'Включить светлую тему')
        : t('themeEnableDark', null, 'Включить тёмную тему')
    );
  }

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, normalized);
    } catch {
      // ignore localStorage access failures
    }
  }
}

function applyLabelsHidden(hidden, options = {}) {
  const { persist = true } = options;
  const normalized = Boolean(hidden);

  if (labelsToggleEl) {
    labelsToggleEl.checked = normalized;
    labelsToggleEl.setAttribute(
      'aria-label',
      normalized
        ? t('labelsShow', null, 'Показывать обозначения карты')
        : t('labelsHide', null, 'Скрыть обозначения карты')
    );
  }

  setLabelsVisibility(!normalized);

  if (persist) {
    try {
      localStorage.setItem(LABELS_HIDDEN_STORAGE_KEY, String(normalized));
    } catch {
      // ignore localStorage access failures
    }
  }
}

function applyMapTheme(theme, options = {}) {
  const { force = false } = options;
  const normalized = theme === 'dark' ? 'dark' : 'light';
  if (!force && currentMapTheme === normalized) return;
  currentMapTheme = normalized;
  map.setStyle(getMapStyleForTheme(normalized), { diff: false });
}

function parseKey(osmKey) {
  if (!osmKey || !osmKey.includes('/')) return null;
  const [osmType, osmIdRaw] = osmKey.split('/');
  const osmId = Number(osmIdRaw);
  if (!['way', 'relation'].includes(osmType) || Number.isNaN(osmId)) return null;
  return { osmType, osmId };
}

function encodeOsmFeatureId(osmType, osmId) {
  const typeBit = osmType === 'relation' ? 1 : 0;
  return (Number(osmId) * 2) + typeBit;
}

function decodeOsmFeatureId(featureId) {
  const n = Number(featureId);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  const osmType = (n % 2) === 1 ? 'relation' : 'way';
  const osmId = Math.floor(n / 2);
  if (!Number.isInteger(osmId) || osmId <= 0) return null;
  return { osmType, osmId };
}

function getFeatureIdentity(feature) {
  const fromKey = parseKey(feature?.properties?.osm_key);
  if (fromKey) return fromKey;
  const osmType = String(feature?.properties?.osm_type || '').trim();
  const osmId = Number(feature?.properties?.osm_id);
  if (['way', 'relation'].includes(osmType) && Number.isInteger(osmId)) {
    return { osmType, osmId };
  }
  const fromEncoded = decodeOsmFeatureId(feature?.id);
  if (fromEncoded) return fromEncoded;
  return null;
}

function safeParseJsonMaybe(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeFeatureInfo(feature) {
  const parsed = safeParseJsonMaybe(feature?.properties?.archiInfo);
  if (parsed && typeof parsed === 'object') {
    if (parsed.archimap_description == null && parsed.description != null) {
      parsed.archimap_description = parsed.description;
    }
    feature.properties.archiInfo = parsed;
  }
}

function renderBuildInfoLink() {
  if (!settingsBuildLinkEl) return;
  settingsBuildLinkEl.href = BUILD_INFO_CONFIG.repoUrl;
  if (settingsBuildTextEl) {
    settingsBuildTextEl.textContent = `${BUILD_INFO_CONFIG.shortSha} | ${BUILD_INFO_CONFIG.version} | archimap`;
  } else {
    settingsBuildLinkEl.textContent = `${BUILD_INFO_CONFIG.shortSha} | ${BUILD_INFO_CONFIG.version} | archimap`;
  }
}

function getSourceTags(feature) {
  const fromSource = safeParseJsonMaybe(feature?.properties?.source_tags);
  if (fromSource && typeof fromSource === 'object') return fromSource;

  const props = { ...(feature?.properties || {}) };
  delete props.osm_key;
  delete props.osm_type;
  delete props.osm_id;
  delete props.archiInfo;
  delete props.hasExtraInfo;
  delete props.has_extra_info;
  delete props.source_tags;
  return props;
}

function getFilterTags(feature) {
  const tags = { ...(getSourceTags(feature) || {}) };
  const parsedInfo = safeParseJsonMaybe(feature?.properties?.archiInfo);
  const info = (parsedInfo && typeof parsedInfo === 'object') ? parsedInfo : (feature?.properties?.archiInfo || null);
  if (!info || typeof info !== 'object') return tags;

  const assignIfPresent = (key, value) => {
    if (value == null) return;
    const text = String(value).trim();
    if (!text) return;
    tags[key] = text;
  };

  const levelsText = info.levels != null && String(info.levels).trim() !== '' ? String(info.levels).trim() : null;
  const yearText = info.year_built != null && String(info.year_built).trim() !== '' ? String(info.year_built).trim() : null;

  assignIfPresent('name', info.name);
  assignIfPresent('address', info.address);
  assignIfPresent('addr:full', info.address);
  assignIfPresent('architect', info.architect);
  assignIfPresent('style', info.style);
  assignIfPresent('building:architecture', info.style);
  assignIfPresent('archimap_description', info.archimap_description || info.description);
  if (levelsText) {
    tags.levels = levelsText;
    tags['building:levels'] = levelsText;
  }
  if (yearText) {
    tags.year_built = yearText;
    tags['building:year'] = yearText;
  }

  return tags;
}

function getFilterTagDisplayName(tagKey) {
  const key = String(tagKey || '').trim();
  if (!key) return '';
  return OSM_FILTER_TAG_LABELS_RU[key] || key;
}

function getFilterTagGroupRank(tagKey) {
  const key = String(tagKey || '').trim();
  if (!key) return 2;
  if (PRIORITY_FILTER_TAG_KEYS.includes(key)) return 0;
  if (APPEARANCE_FILTER_TAG_KEYS.includes(key)) return 1;
  if (APPEARANCE_FILTER_TAG_PREFIXES.some((prefix) => key.startsWith(prefix))) return 1;
  return 2;
}

function normalizeTagValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getFilterRules() {
  if (!filterRowsEl) return [];
  const rows = [...filterRowsEl.querySelectorAll('[data-filter-row]')];
  return rows.map((row) => {
    const key = String(row.querySelector('[data-field="key"]')?.value || '').trim();
    const op = String(row.querySelector('[data-field="op"]')?.value || 'contains').trim();
    const value = String(row.querySelector('[data-field="value"]')?.value || '').trim();
    return { key, op, value };
  }).filter((rule) => {
    if (!rule.key) return false;
    if (rule.op === 'exists' || rule.op === 'not_exists') return true;
    return rule.value.length > 0;
  });
}

function matchesRule(tags, rule) {
  if (!rule || !rule.key) return false;
  const hasKey = Object.prototype.hasOwnProperty.call(tags || {}, rule.key);
  const rawValue = hasKey ? tags[rule.key] : undefined;
  const lhs = normalizeTagValue(rawValue).toLowerCase();
  const rhs = String(rule.value || '').toLowerCase();

  if (rule.op === 'exists') return hasKey;
  if (rule.op === 'not_exists') return !hasKey;
  if (!hasKey) return false;
  if (rule.op === 'equals') return lhs === rhs;
  if (rule.op === 'not_equals') return lhs !== rhs;
  if (rule.op === 'starts_with') return lhs.startsWith(rhs);
  return lhs.includes(rhs);
}

function setLocalBuildingFeatureState(osmKey, state) {
  const parsed = parseKey(osmKey);
  if (!parsed) return;
  const id = encodeOsmFeatureId(parsed.osmType, parsed.osmId);
  try {
    map.setFeatureState(
      { source: 'local-buildings', sourceLayer: PMTILES_CONFIG.sourceLayer, id },
      state
    );
  } catch {
    // source may be reloading while style/theme switches
  }
}

function setLocalBuildingFilterState(osmKey, isFiltered, hasExtraInfo) {
  const key = String(osmKey || '').trim();
  if (!key) return;
  const normalized = {
    isFiltered: Boolean(isFiltered),
    hasExtraInfo: Boolean(hasExtraInfo)
  };
  const prev = filterFeatureStateCache.get(key);
  if (prev && prev.isFiltered === normalized.isFiltered && prev.hasExtraInfo === normalized.hasExtraInfo) {
    return;
  }
  filterFeatureStateCache.set(key, normalized);
  setLocalBuildingFeatureState(key, normalized);
}

async function ensureDbFilterTagKeysLoaded() {
  if (dbFilterTagKeysLoaded) return;
  if (dbFilterTagKeysLoadingPromise) return dbFilterTagKeysLoadingPromise;
  dbFilterTagKeysLoadingPromise = fetch('/api/filter-tag-keys')
    .then((resp) => (resp.ok ? resp.json() : null))
    .then((payload) => {
      const keys = Array.isArray(payload?.keys) ? payload.keys : [];
      const warmingUp = Boolean(payload?.warmingUp);
      dbFilterTagKeys = keys.map((key) => String(key || '').trim()).filter(Boolean);
      dbFilterTagKeysLoaded = dbFilterTagKeys.length > 0 || !warmingUp;
      refreshTagKeysDatalist();
      if (!dbFilterTagKeysLoaded) {
        if (dbFilterTagKeysRetryTimer) clearTimeout(dbFilterTagKeysRetryTimer);
        dbFilterTagKeysRetryTimer = setTimeout(() => {
          dbFilterTagKeysRetryTimer = null;
          ensureDbFilterTagKeysLoaded();
        }, 1500);
      }
    })
    .catch(() => {
      dbFilterTagKeys = [];
      dbFilterTagKeysLoaded = false;
      if (dbFilterTagKeysRetryTimer) clearTimeout(dbFilterTagKeysRetryTimer);
      dbFilterTagKeysRetryTimer = setTimeout(() => {
        dbFilterTagKeysRetryTimer = null;
        ensureDbFilterTagKeysLoaded();
      }, 2500);
    })
    .finally(() => {
      dbFilterTagKeysLoadingPromise = null;
    });
  return dbFilterTagKeysLoadingPromise;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function upsertFilterDataCacheItem(item) {
  const key = String(item?.osmKey || '').trim();
  if (!key) return;
  const normalized = {
    osmKey: key,
    sourceTags: item?.sourceTags && typeof item.sourceTags === 'object' ? item.sourceTags : {},
    archiInfo: item?.archiInfo && typeof item.archiInfo === 'object' ? item.archiInfo : null,
    hasExtraInfo: Boolean(item?.hasExtraInfo)
  };
  filterDataCache.delete(key);
  filterDataCache.set(key, { cachedAt: Date.now(), item: normalized });
  while (filterDataCache.size > FILTER_DATA_CACHE_MAX_ITEMS) {
    const oldestKey = filterDataCache.keys().next().value;
    if (!oldestKey) break;
    filterDataCache.delete(oldestKey);
  }
}

function getFilterDataFromCache(key) {
  const entry = filterDataCache.get(key);
  if (!entry) return null;
  if ((Date.now() - entry.cachedAt) > FILTER_DATA_CACHE_TTL_MS) {
    filterDataCache.delete(key);
    return null;
  }
  filterDataCache.delete(key);
  filterDataCache.set(key, entry);
  return entry.item;
}

function getPaddedViewportBounds() {
  const bounds = map.getBounds();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const spanLon = Math.max(0.0001, east - west);
  const spanLat = Math.max(0.0001, north - south);
  const padLon = spanLon * FILTER_PREFETCH_PADDING_RATIO;
  const padLat = spanLat * FILTER_PREFETCH_PADDING_RATIO;
  return {
    minLon: clamp(west - padLon, -180, 180),
    maxLon: clamp(east + padLon, -180, 180),
    minLat: clamp(south - padLat, -85, 85),
    maxLat: clamp(north + padLat, -85, 85)
  };
}

async function prefetchFilterDataByViewportBounds() {
  const b = getPaddedViewportBounds();
  const params = new URLSearchParams({
    minLon: b.minLon.toFixed(6),
    minLat: b.minLat.toFixed(6),
    maxLon: b.maxLon.toFixed(6),
    maxLat: b.maxLat.toFixed(6),
    limit: String(FILTER_PREFETCH_LIMIT)
  });
  const url = `/api/buildings/filter-data-bbox?${params.toString()}`;
  if (filterPrefetchInFlight.has(url)) {
    await filterPrefetchInFlight.get(url);
    return;
  }
  const task = fetch(url, { cache: 'default' })
    .then((resp) => (resp.ok ? resp.json() : null))
    .then((payload) => {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      for (const item of items) upsertFilterDataCacheItem(item);
    })
    .catch(() => {
      // ignore prefetch failures, fallback key-based fetch will handle misses
    })
    .finally(() => {
      filterPrefetchInFlight.delete(url);
    });
  filterPrefetchInFlight.set(url, task);
  await task;
}

async function fetchFilterDataByOsmKeys(keys) {
  const normalized = [...new Set((keys || [])
    .map((key) => String(key || '').trim())
    .filter((key) => /^(way|relation)\/\d+$/.test(key))
  )];
  if (normalized.length === 0) return new Map();

  const CHUNK_SIZE = 700;
  const out = new Map();
  const missing = [];
  for (const key of normalized) {
    const cached = getFilterDataFromCache(key);
    if (cached) {
      out.set(key, cached);
    } else {
      missing.push(key);
    }
  }

  for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
    const chunk = missing.slice(i, i + CHUNK_SIZE);
    const resp = await fetch('/api/buildings/filter-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: chunk })
    });
    if (!resp.ok) continue;
    const payload = await resp.json().catch(() => ({ items: [] }));
    const items = Array.isArray(payload?.items) ? payload.items : [];
    for (const item of items) {
      const key = String(item?.osmKey || '').trim();
      if (!key) continue;
      upsertFilterDataCacheItem(item);
      const cached = getFilterDataFromCache(key);
      if (cached) out.set(key, cached);
    }
  }
  return out;
}

async function hydrateVisibleBuildingsForFiltering(features, loadSeq) {
  if (!Array.isArray(features) || features.length === 0) return;
  const keys = features
    .map((feature) => String(feature?.properties?.osm_key || feature?.id || '').trim())
    .filter(Boolean);
  const byKey = await fetchFilterDataByOsmKeys(keys);
  if (loadSeq !== visibleBuildingsLoadSeq) return;
  for (const feature of features) {
    const key = String(feature?.properties?.osm_key || feature?.id || '').trim();
    if (!key) continue;
    const item = byKey.get(key);
    if (!item) continue;
    feature.properties = feature.properties || {};
    feature.properties.source_tags = item.sourceTags && typeof item.sourceTags === 'object' ? item.sourceTags : {};
    feature.properties.archiInfo = item.archiInfo && typeof item.archiInfo === 'object' ? item.archiInfo : null;
    feature.properties.has_extra_info = item.hasExtraInfo ? 1 : 0;
    feature.properties.hasExtraInfo = Boolean(item.hasExtraInfo);
  }
}

function applyFiltersToCurrentData() {
  if (!currentBuildingsGeojson || !Array.isArray(currentBuildingsGeojson.features)) return;
  const rules = getFilterRules();
  let matched = 0;
  const nextVisibleKeys = new Set();

  for (const feature of currentBuildingsGeojson.features) {
    const key = String(feature?.properties?.osm_key || feature?.id || '');
    if (!key) continue;
    nextVisibleKeys.add(key);
    const tags = getFilterTags(feature);
    const isFiltered = rules.length > 0 && rules.every((rule) => matchesRule(tags, rule));
    feature.properties = feature.properties || {};
    feature.properties.isFiltered = isFiltered;
    const hasExtraInfo = localEditStateOverrides.get(key) ?? Boolean(Number(feature.properties?.has_extra_info || 0));
    feature.properties.hasExtraInfo = hasExtraInfo;
    setLocalBuildingFilterState(key, isFiltered, hasExtraInfo);
    if (isFiltered) matched += 1;
  }

  for (const prevKey of currentVisibleBuildingKeys) {
    if (nextVisibleKeys.has(prevKey)) continue;
    filterFeatureStateCache.delete(prevKey);
    setLocalBuildingFeatureState(prevKey, { isFiltered: false });
  }
  currentVisibleBuildingKeys = nextVisibleKeys;

  if (!filterStatusEl) return;
  const total = currentBuildingsGeojson.features.length;
  if (rules.length === 0) {
    filterStatusEl.textContent = t('filterInactive', null, 'Фильтр не активен.');
  } else {
    filterStatusEl.textContent = t(
      'filterMatchedInViewport',
      { matched, total },
      `Подсвечено ${matched} из ${total} зданий в текущем окне карты.`
    );
  }
}

function refreshTagKeysDatalist() {
  if (!filterTagKeysEl) return;
  const keys = new Set();
  if (dbFilterTagKeysLoaded && Array.isArray(dbFilterTagKeys) && dbFilterTagKeys.length > 0) {
    for (const key of dbFilterTagKeys) keys.add(key);
  } else {
    for (const feature of currentBuildingsGeojson.features || []) {
      const tags = getFilterTags(feature);
      for (const key of Object.keys(tags || {})) {
        keys.add(key);
      }
    }
  }

  const sorted = [...keys].sort((a, b) => {
    const aGroup = getFilterTagGroupRank(a);
    const bGroup = getFilterTagGroupRank(b);
    if (aGroup !== bGroup) return aGroup - bGroup;
    const aLabel = getFilterTagDisplayName(a);
    const bLabel = getFilterTagDisplayName(b);
    return aLabel.localeCompare(bLabel, 'ru');
  });
  const signature = sorted.join('\n');
  if (signature === lastRenderedFilterTagKeysSignature) return;
  lastRenderedFilterTagKeysSignature = signature;
  filterTagKeysEl.innerHTML = sorted.map((k) => {
    const display = getFilterTagDisplayName(k);
    return `<option value="${escapeHtml(k)}" label="${escapeHtml(display)}">${escapeHtml(display)}</option>`;
  }).join('');
}

function buildFilterRow() {
  const row = document.createElement('div');
  row.dataset.filterRow = String(++filterRowSeq);
  row.className = 'grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5';
  row.innerHTML = `
    <input data-field="key" list="filter-tag-keys" placeholder="${escapeHtml(t('filterKeyPlaceholder', null, 'Тег, например building:levels'))}" class="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
    <select data-field="op" class="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200">
      <option value="contains">${escapeHtml(t('filterOpContains', null, 'содержит'))}</option>
      <option value="equals">${escapeHtml(t('filterOpEquals', null, 'равно'))}</option>
      <option value="not_equals">${escapeHtml(t('filterOpNotEquals', null, 'не равно'))}</option>
      <option value="starts_with">${escapeHtml(t('filterOpStartsWith', null, 'начинается с'))}</option>
      <option value="exists">${escapeHtml(t('filterOpExists', null, 'существует'))}</option>
      <option value="not_exists">${escapeHtml(t('filterOpNotExists', null, 'отсутствует'))}</option>
    </select>
    <input data-field="value" placeholder="${escapeHtml(t('filterValuePlaceholder', null, 'Значение'))}" class="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
    <button data-action="remove" type="button" class="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 text-slate-500 hover:bg-slate-100 hover:text-slate-900">×</button>
  `;
  return row;
}

function onFilterRowsChange(event) {
  const row = event.target?.closest?.('[data-filter-row]');
  if (!row) return;
  const op = row.querySelector('[data-field="op"]')?.value;
  const valueInput = row.querySelector('[data-field="value"]');
  if (valueInput) {
    valueInput.disabled = (op === 'exists' || op === 'not_exists');
  }
  applyFiltersToCurrentData();
  // If filters became active after being idle, ensure viewport data is loaded
  // immediately instead of waiting for the next map move/zoom event.
  if (getFilterRules().length > 0 && (currentBuildingsGeojson.features || []).length === 0) {
    scheduleLoadBuildings();
  }
}

function shouldProcessVisibleBuildings() {
  const hasActiveRules = getFilterRules().length > 0;
  const needsAdminHighlight = Boolean(isAuthenticated && isAdmin);
  return hasActiveRules || needsAdminHighlight;
}

function addFilterRow() {
  if (!filterRowsEl) return;
  filterRowsEl.appendChild(buildFilterRow());
}

function resetFilterRows() {
  if (!filterRowsEl) return;
  filterRowsEl.innerHTML = '';
  addFilterRow();
  applyFiltersToCurrentData();
}

const FILTER_PANEL_OPEN_CLASSES = [
  'max-h-[70vh]',
  'translate-y-0',
  'scale-100',
  'opacity-100',
  'pointer-events-auto',
  'overflow-auto'
];

const FILTER_PANEL_CLOSED_CLASSES = [
  'max-h-0',
  '-translate-y-2',
  'scale-95',
  'opacity-0',
  'pointer-events-none',
  'overflow-hidden'
];

const MOBILE_CONTROLS_OPEN_CLASSES = [
  'max-h-[420px]',
  'translate-y-0',
  'scale-100',
  'opacity-100',
  'pointer-events-auto',
  'overflow-hidden'
];

const MOBILE_CONTROLS_CLOSED_CLASSES = [
  'max-h-0',
  '-translate-y-2',
  'scale-95',
  'opacity-0',
  'pointer-events-none',
  'overflow-hidden'
];

function isFilterPanelOpen() {
  return Boolean(filterShellEl && filterShellEl.classList.contains('pointer-events-auto'));
}

function setFilterToggleButtonState(isOpen) {
  if (!filterToggleBtnEl) return;
  filterToggleBtnEl.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  filterToggleBtnEl.setAttribute(
    'aria-label',
    isOpen
      ? t('filterPanelClose', null, 'Скрыть фильтр')
      : t('filterPanelOpen', null, 'Открыть фильтр')
  );
  filterToggleBtnEl.classList.toggle('bg-indigo-600', isOpen);
  filterToggleBtnEl.classList.toggle('border-indigo-600', isOpen);
  filterToggleBtnEl.classList.toggle('text-white', isOpen);
  filterToggleBtnEl.classList.toggle('hover:bg-indigo-500', isOpen);
  filterToggleBtnEl.classList.toggle('bg-white', !isOpen);
  filterToggleBtnEl.classList.toggle('border-slate-300', !isOpen);
  filterToggleBtnEl.classList.toggle('text-slate-800', !isOpen);
  filterToggleBtnEl.classList.toggle('hover:bg-slate-50', !isOpen);
}

function openFilterPanel() {
  if (!filterShellEl) return;
  filterShellEl.classList.remove(...FILTER_PANEL_CLOSED_CLASSES);
  filterShellEl.classList.add(...FILTER_PANEL_OPEN_CLASSES);
  setFilterToggleButtonState(true);
  ensureDbFilterTagKeysLoaded();
  scheduleLoadBuildings();
}

function closeFilterPanel() {
  if (!filterShellEl) return;
  filterShellEl.classList.remove(...FILTER_PANEL_OPEN_CLASSES);
  filterShellEl.classList.add(...FILTER_PANEL_CLOSED_CLASSES);
  setFilterToggleButtonState(false);
  scheduleLoadBuildings();
}

function toggleFilterPanel() {
  if (isFilterPanelOpen()) {
    closeFilterPanel();
    return;
  }
  openFilterPanel();
}

function isMobileControlsPanelOpen() {
  return Boolean(mobileControlsShellEl && mobileControlsShellEl.classList.contains('pointer-events-auto'));
}

function setMobileControlsToggleButtonState(isOpen) {
  if (!mobileControlsToggleBtnEl) return;
  mobileControlsToggleBtnEl.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  mobileControlsToggleBtnEl.setAttribute(
    'aria-label',
    isOpen
      ? t('switchesPanelClose', null, 'Скрыть переключатели')
      : t('switchesPanelOpen', null, 'Открыть переключатели')
  );
  mobileControlsToggleBtnEl.classList.toggle('bg-indigo-600', isOpen);
  mobileControlsToggleBtnEl.classList.toggle('border-indigo-600', isOpen);
  mobileControlsToggleBtnEl.classList.toggle('text-white', isOpen);
  mobileControlsToggleBtnEl.classList.toggle('hover:bg-indigo-500', isOpen);
  mobileControlsToggleBtnEl.classList.toggle('bg-white', !isOpen);
  mobileControlsToggleBtnEl.classList.toggle('border-slate-300', !isOpen);
  mobileControlsToggleBtnEl.classList.toggle('text-slate-800', !isOpen);
  mobileControlsToggleBtnEl.classList.toggle('hover:bg-slate-50', !isOpen);
}

function openMobileControlsPanel() {
  if (!mobileControlsShellEl) return;
  mobileControlsShellEl.classList.remove(...MOBILE_CONTROLS_CLOSED_CLASSES);
  mobileControlsShellEl.classList.add(...MOBILE_CONTROLS_OPEN_CLASSES);
  setMobileControlsToggleButtonState(true);
}

function closeMobileControlsPanel() {
  if (!mobileControlsShellEl) return;
  mobileControlsShellEl.classList.remove(...MOBILE_CONTROLS_OPEN_CLASSES);
  mobileControlsShellEl.classList.add(...MOBILE_CONTROLS_CLOSED_CLASSES);
  setMobileControlsToggleButtonState(false);
}

function toggleMobileControlsPanel() {
  if (isMobileControlsPanelOpen()) {
    closeMobileControlsPanel();
    return;
  }
  openMobileControlsPanel();
}

function setLabelsVisibility(show) {
  const style = map.getStyle();
  if (!style || !Array.isArray(style.layers)) return;
  const visibility = show ? 'visible' : 'none';
  for (const layer of style.layers) {
    if (layer.type !== 'symbol') continue;
    try {
      map.setLayoutProperty(layer.id, 'visibility', visibility);
    } catch {
      // ignore non-existing layer race conditions
    }
  }
}

function getVisibleBuildingsSnapshot() {
  const seen = new Set();
  const features = [];
  let sourceFeatures = [];
  try {
    sourceFeatures = map.queryRenderedFeatures({ layers: ['local-buildings-fill'] }) || [];
  } catch {
    sourceFeatures = [];
  }
  if (sourceFeatures.length === 0) {
    try {
      sourceFeatures = map.querySourceFeatures('local-buildings', {
        sourceLayer: PMTILES_CONFIG.sourceLayer
      }) || [];
    } catch {
      sourceFeatures = [];
    }
  }
  for (const feature of sourceFeatures) {
    const identity = getFeatureIdentity(feature);
    if (!identity) continue;
    const key = `${identity.osmType}/${identity.osmId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    feature.properties = feature.properties || {};
    feature.properties.osm_key = key;
    feature.properties.osm_type = identity.osmType;
    feature.properties.osm_id = identity.osmId;
    features.push(feature);
  }
  return features;
}

function getCartoBuildingLayerIds() {
  const style = map.getStyle();
  if (!style || !Array.isArray(style.layers)) return [];
  return style.layers
    .filter((layer) => layer?.source === CARTO_BUILDINGS_SOURCE_ID && layer?.['source-layer'] === CARTO_BUILDINGS_SOURCE_LAYER)
    .map((layer) => layer.id);
}

function setCartoBuildingsVisibility(isVisible) {
  if (lastCartoBuildingsVisibility === isVisible) return;
  const layerIds = getCartoBuildingLayerIds();
  const visibility = isVisible ? 'visible' : 'none';
  for (const layerId of layerIds) {
    try {
      map.setLayoutProperty(layerId, 'visibility', visibility);
    } catch {
      // ignore transient style updates
    }
  }
  lastCartoBuildingsVisibility = isVisible;
}

function updateCartoBuildingsVisibility() {
  if (!map.getLayer('local-buildings-fill')) {
    setCartoBuildingsVisibility(true);
    return;
  }

  if (map.getZoom() < MIN_BUILDING_ZOOM) {
    setCartoBuildingsVisibility(true);
    return;
  }

  let renderedFeatures = [];
  try {
    renderedFeatures = map.queryRenderedFeatures({ layers: ['local-buildings-fill'] }) || [];
  } catch {
    renderedFeatures = [];
  }

  const uniqueVisibleKeys = new Set();
  for (const feature of renderedFeatures) {
    const identity = getFeatureIdentity(feature);
    if (!identity) continue;
    uniqueVisibleKeys.add(`${identity.osmType}/${identity.osmId}`);
    if (uniqueVisibleKeys.size > 0) break;
  }

  setCartoBuildingsVisibility(uniqueVisibleKeys.size === 0);
}

function osmAddressFromTags(tags) {
  if (!tags) return null;
  if (tags['addr:full']) return tags['addr:full'];
  const parts = [
    tags['addr:postcode'] || tags.addr_postcode,
    tags['addr:city'] || tags.addr_city,
    tags['addr:street'] || tags.addr_street || tags.addr_stree,
    tags['addr:housenumber'] || tags.addr_housenumber || tags.addr_hous
  ]
    .filter(Boolean)
    .map((x) => String(x).trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function getAddressFormState(tags, infoAddress) {
  const readTag = (...keys) => {
    for (const key of keys) {
      const value = tags?.[key];
      if (value == null) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return '';
  };

  const state = {
    full: readTag('addr:full'),
    postcode: readTag('addr:postcode', 'addr_postcode'),
    city: readTag('addr:city', 'addr_city'),
    place: readTag('addr:place', 'addr_place'),
    street: readTag('addr:street', 'addr_street', 'addr_stree'),
    housenumber: readTag('addr:housenumber', 'addr_housenumber', 'addr_hous')
  };

  const hasAnyOsmAddressPart = Object.values(state).some((value) => value);
  if (!hasAnyOsmAddressPart && infoAddress) {
    state.full = String(infoAddress).trim();
  }

  return state;
}

function buildAddressFromForm(formData) {
  const full = String(formData.get('building-addr-full') || '').trim();
  if (full) return full;

  const parts = [
    String(formData.get('building-addr-postcode') || '').trim(),
    String(formData.get('building-addr-city') || '').trim(),
    String(formData.get('building-addr-place') || '').trim(),
    String(formData.get('building-addr-street') || '').trim()
  ].filter(Boolean);

  const house = String(formData.get('building-addr-housenumber') || '').trim();
  if (house) {
    if (parts.length > 0) {
      parts[parts.length - 1] = `${parts[parts.length - 1]}, ${house}`;
    } else {
      parts.push(house);
    }
  }

  return parts.join(', ');
}

function osmYearFromTags(tags) {
  if (!tags) return null;
  return tags['building:year'] || tags.start_date || tags.construction_date || tags.year_built || null;
}

function osmArchitectFromTags(tags) {
  if (!tags) return null;
  return tags.architect || tags.architect_name || null;
}

function osmStyleFromTags(tags) {
  if (!tags) return null;
  return tags['building:architecture'] || tags.architecture || tags.style || null;
}

function osmDescriptionFromTags(tags) {
  if (!tags) return null;
  return tags['description:ru'] || tags.description || null;
}

const ARCHITECTURE_STYLE_LABELS_RU = Object.freeze(I18N_RU.architectureStyleLabels || {});

const ARCHITECTURE_STYLE_ALIASES = Object.freeze(I18N_RU.architectureStyleAliases || {});

const ARCHITECTURE_STYLE_KEY_BY_LABEL_NORMALIZED = (() => {
  const map = new Map();
  for (const [key, label] of Object.entries(ARCHITECTURE_STYLE_LABELS_RU)) {
    const normalizedLabel = normalizeStyleSearchText(label);
    if (normalizedLabel) map.set(normalizedLabel, key);
  }
  return map;
})();

function normalizeStyleSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveArchitectureStyleSearchKey(queryText) {
  const raw = String(queryText || '').trim();
  if (!raw) return null;
  const normalizedQuery = normalizeStyleSearchText(raw);
  if (!normalizedQuery) return null;

  if (ARCHITECTURE_STYLE_LABELS_RU[normalizedQuery]) {
    return normalizedQuery;
  }

  if (ARCHITECTURE_STYLE_ALIASES[normalizedQuery]) {
    return ARCHITECTURE_STYLE_ALIASES[normalizedQuery];
  }

  const byLabel = ARCHITECTURE_STYLE_KEY_BY_LABEL_NORMALIZED.get(normalizedQuery);
  if (byLabel) return byLabel;

  return null;
}

function resolveArchitectureStyleSearchKeys(queryText) {
  const raw = String(queryText || '').trim();
  if (!raw) return [];
  const normalizedQuery = normalizeStyleSearchText(raw);
  if (!normalizedQuery || normalizedQuery.length < 2) return [];

  const matched = new Set();
  for (const [key, label] of Object.entries(ARCHITECTURE_STYLE_LABELS_RU)) {
    const normalizedLabel = normalizeStyleSearchText(label);
    const normalizedKey = normalizeStyleSearchText(key.replace(/_/g, ' '));
    if (
      normalizedLabel.includes(normalizedQuery) ||
      normalizedQuery.includes(normalizedLabel) ||
      normalizedKey.includes(normalizedQuery)
    ) {
      matched.add(key);
    }
  }

  for (const [alias, canonical] of Object.entries(ARCHITECTURE_STYLE_ALIASES)) {
    const normalizedAlias = normalizeStyleSearchText(alias.replace(/_/g, ' '));
    if (normalizedAlias.includes(normalizedQuery) || normalizedQuery.includes(normalizedAlias)) {
      matched.add(canonical);
    }
  }

  const exact = resolveArchitectureStyleSearchKey(raw);
  if (exact) matched.add(exact);

  return Array.from(matched);
}

function toHumanArchitectureStyle(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;

  const parts = text
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length === 0) return text;

  const translated = parts.map((part) => {
    const rawKey = part.toLowerCase();
    const key = ARCHITECTURE_STYLE_ALIASES[rawKey] || rawKey;
    return ARCHITECTURE_STYLE_LABELS_RU[key] || part;
  });
  return translated.join('; ');
}

function getArchitectureStyleOptions() {
  return Object.entries(ARCHITECTURE_STYLE_LABELS_RU)
    .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'ru'))
    .map(([key, label]) => ({ key, label }));
}

function getArchitectureStyleEditState(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return { selectedKey: '' };
  }

  const lowered = raw.toLowerCase();
  if (ARCHITECTURE_STYLE_LABELS_RU[lowered]) {
    return { selectedKey: lowered };
  }
  if (ARCHITECTURE_STYLE_ALIASES[lowered]) {
    return { selectedKey: ARCHITECTURE_STYLE_ALIASES[lowered] };
  }

  for (const [key, label] of Object.entries(ARCHITECTURE_STYLE_LABELS_RU)) {
    if (String(label).toLowerCase() === lowered) {
      return { selectedKey: key };
    }
  }

  return { selectedKey: '' };
}

function normalizeArchitectureStyleForSave(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const keyByLabel = new Map();
  for (const [key, label] of Object.entries(ARCHITECTURE_STYLE_LABELS_RU)) {
    keyByLabel.set(String(label).toLowerCase(), key);
  }

  const lowered = text.toLowerCase();
  if (ARCHITECTURE_STYLE_LABELS_RU[lowered]) return lowered;
  if (ARCHITECTURE_STYLE_ALIASES[lowered]) return ARCHITECTURE_STYLE_ALIASES[lowered];
  if (keyByLabel.has(lowered)) return keyByLabel.get(lowered) || text;
  return text;
}

function normalizeArchitectureStyleKey(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (ARCHITECTURE_STYLE_ALIASES[text]) return ARCHITECTURE_STYLE_ALIASES[text];
  const byLabel = ARCHITECTURE_STYLE_KEY_BY_LABEL_NORMALIZED.get(normalizeStyleSearchText(text));
  if (byLabel) return byLabel;
  return text;
}

function extractArchitectureStyleKeys(value) {
  return String(value || '')
    .split(';')
    .map((part) => normalizeArchitectureStyleKey(part))
    .filter(Boolean);
}

function filterSearchItemsByStyleKey(items, styleSearchKey) {
  if (!styleSearchKey) return Array.isArray(items) ? items : [];
  return filterSearchItemsByStyleKeys(items, [styleSearchKey]);
}

function filterSearchItemsByStyleKeys(items, styleSearchKeys) {
  const targetKeys = new Set(
    (Array.isArray(styleSearchKeys) ? styleSearchKeys : [])
      .map((key) => normalizeArchitectureStyleKey(key))
      .filter(Boolean)
  );
  if (targetKeys.size === 0) return Array.isArray(items) ? items : [];
  return (Array.isArray(items) ? items : []).filter((item) => {
    const keys = extractArchitectureStyleKeys(item?.style);
    return keys.some((key) => targetKeys.has(key));
  });
}

async function fetchBuildingSearchChunk(queryText, center, cursor = 0) {
  const params = new URLSearchParams({
    q: String(queryText || '').slice(0, 120),
    lon: String(center.lng ?? center.lon ?? 0),
    lat: String(center.lat),
    limit: String(SEARCH_RESULTS_LIMIT)
  });
  if (cursor > 0) params.set('cursor', String(cursor));
  const resp = await fetch(`/api/search-buildings?${params.toString()}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: t('searchError', null, 'Ошибка поиска') }));
    throw new Error(String(err.error || t('searchError', null, 'Ошибка поиска')));
  }
  const data = await resp.json().catch(() => ({ items: [], hasMore: false, nextCursor: null }));
  return {
    items: Array.isArray(data.items) ? data.items : [],
    hasMore: Boolean(data.hasMore),
    nextCursor: Number.isFinite(data.nextCursor) ? Number(data.nextCursor) : null
  };
}

function dedupeSearchItems(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const key = `${String(item?.osmType || '')}/${String(item?.osmId || '')}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function osmNameFromTags(tags) {
  if (!tags) return null;
  return tags.name || tags['name:ru'] || tags['official_name'] || null;
}

function osmLevelsFromTags(tags) {
  if (!tags) return null;
  return tags['building:levels'] || tags.levels || null;
}

async function loadAuthState() {
  const resp = await fetch('/api/me');
  const data = await resp.json();
  isAuthenticated = Boolean(data.authenticated);
  currentUser = data?.user || null;
  isAdmin = Boolean(currentUser?.isAdmin);
  isMasterAdmin = Boolean(currentUser?.isMasterAdmin);
  canEditBuildings = Boolean(currentUser?.canEditBuildings || isAdmin);
  csrfToken = String(data?.csrfToken || '') || null;
  renderAuth();
}

function renderAuth() {
  isMasterAdmin = Boolean(currentUser?.isMasterAdmin);
  canEditBuildings = Boolean(currentUser?.canEditBuildings || isAdmin);
  if (loginUsernameEl) {
    loginUsernameEl.placeholder = t('authLoginEmailPlaceholder', null, 'Email');
  }

  if (isAuthenticated) {
    authStatusEl.textContent = t('authLoggedIn', null, 'Вы авторизованы');
    logoutBtn.classList.remove('hidden');
    loginForm.classList.add('hidden');
    if (registerPanelEl) registerPanelEl.classList.add('hidden');
    if (forgotPasswordPanelEl) forgotPasswordPanelEl.classList.add('hidden');
    if (registerVerifyPanelEl) registerVerifyPanelEl.classList.add('hidden');
  } else {
    authStatusEl.textContent = '';
    logoutBtn.classList.add('hidden');
    loginForm.classList.remove('hidden');
    if (authTabRegisterEl) authTabRegisterEl.classList.toggle('hidden', !isRegistrationUiEnabled());
  }

  if (!isAuthenticated) {
    closeProfileModal();
  } else {
    const email = String(currentUser?.email || '');
    const firstName = String(currentUser?.firstName || '').trim();
    const lastName = String(currentUser?.lastName || '').trim();
    if (profileEmailEl) profileEmailEl.textContent = email
      ? t('profileEmailPrefix', { email }, `Email: ${email}`)
      : t('authLoggedInShort', null, 'Вход выполнен');
    if (profileFirstNameEl) profileFirstNameEl.value = firstName;
    if (profileLastNameEl) profileLastNameEl.value = lastName;
  }

  if (authFabEl) {
    if (isAuthenticated) {
      const profileText = t('authFabProfile', null, 'Профиль');
      authFabEl.setAttribute('aria-label', profileText);
      authFabEl.textContent = profileText;
      authFabEl.setAttribute('href', '/account/');
    } else {
      const loginText = t('authFabLogin', null, 'Войти');
      authFabEl.setAttribute('aria-label', loginText);
      authFabEl.textContent = loginText;
      authFabEl.setAttribute('href', '/?auth=1&next=%2F');
    }
  }

  if (adminLinkEl) {
    adminLinkEl.classList.toggle('hidden', !isAuthenticated || !isAdmin);
  }

  if (uiKitLinkEl) {
    uiKitLinkEl.classList.toggle('hidden', !isAuthenticated || !isAdmin);
  }

  if (settingsLogoutBtnEl) {
    settingsLogoutBtnEl.classList.toggle('hidden', !isAuthenticated);
  }

  updateBuildingHighlightStyle();
  scheduleLoadBuildings();

  if (selected && !modalEl.classList.contains('hidden')) {
    openModal(selected.feature);
  }
}

function getBuildingFillColorExpression() {
  const style = getLocalBuildingStyleForTheme(currentMapTheme);
  return [
    'case',
    ['boolean', ['feature-state', 'isHovered'], false],
    ['case',
    ['boolean', ['feature-state', 'isFiltered'], false],
    style.fill.hoverFiltered,
    style.fill.hoverNormal],
    ['boolean', ['feature-state', 'isFiltered'], false],
    style.fill.filtered,
    style.fill.normal
  ];
}

function getBuildingFillOpacityExpression() {
  const style = getLocalBuildingStyleForTheme(currentMapTheme);
  return [
    'case',
    ['boolean', ['feature-state', 'isHovered'], false],
    style.fill.opacityHover,
    ['boolean', ['feature-state', 'isFiltered'], false],
    style.fill.opacityActive,
    style.fill.opacityNormal
  ];
}

function getBuildingLineColorExpression() {
  const style = getLocalBuildingStyleForTheme(currentMapTheme);
  return [
    'case',
    ['boolean', ['feature-state', 'isHovered'], false],
    ['case',
    ['boolean', ['feature-state', 'isFiltered'], false],
    style.line.hoverFiltered,
    style.line.hoverNormal],
    ['boolean', ['feature-state', 'isFiltered'], false],
    style.line.filtered,
    style.line.normal
  ];
}

function getBuildingLineWidthExpression() {
  const style = getLocalBuildingStyleForTheme(currentMapTheme);
  return [
    'case',
    ['boolean', ['feature-state', 'isHovered'], false],
    style.line.widthHover,
    ['boolean', ['feature-state', 'isFiltered'], false],
    style.line.widthFiltered,
    style.line.widthNormal
  ];
}

function updateBuildingHighlightStyle() {
  if (!map.getLayer('local-buildings-fill') || !map.getLayer('local-buildings-line')) return;
  map.setPaintProperty('local-buildings-fill', 'fill-color', getBuildingFillColorExpression());
  map.setPaintProperty('local-buildings-fill', 'fill-opacity', getBuildingFillOpacityExpression());
  map.setPaintProperty('local-buildings-line', 'line-color', getBuildingLineColorExpression());
  map.setPaintProperty('local-buildings-line', 'line-width', getBuildingLineWidthExpression());
}

function splitSemicolonValues(value) {
  return String(value || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildCopyChips(items, emptyFallback = '-') {
  if (!Array.isArray(items) || items.length === 0) return escapeHtml(emptyFallback);
  const chips = items.map((item) => {
    const raw = String(item?.raw ?? '').trim();
    const label = String(item?.label ?? raw).trim();
    if (!raw || !label) return '';
    return `<button type="button" data-copy-chip="true" data-copy-value="${escapeHtml(raw)}" class="inline-flex items-center rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-800 transition hover:bg-slate-200">${escapeHtml(label)}</button>`;
  }).join('');
  return `<div class="flex flex-wrap gap-1.5">${chips}</div>`;
}

function buildReadonlyField(label, valueHtml) {
  return `
    <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
      <div class="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">${escapeHtml(label)}</div>
      <div class="text-sm leading-5 text-slate-800">${valueHtml}</div>
    </div>
  `;
}

function buildModalHtml(feature) {
  const info = feature.properties?.archiInfo || {};
  const osmTags = getSourceTags(feature);
  const addressForm = getAddressFormState(osmTags, info.address);
  const osmAddress = osmAddressFromTags(osmTags);
  const osmYear = osmYearFromTags(osmTags);
  const osmArchitect = osmArchitectFromTags(osmTags);
  const osmStyle = osmStyleFromTags(osmTags);
  const osmDescription = osmDescriptionFromTags(osmTags);
  const osmName = osmNameFromTags(osmTags);
  const osmLevels = osmLevelsFromTags(osmTags);

  const shownName = info.name || osmName || '-';
  const shownAddress = info.address || osmAddress || '-';
  const shownLevels = info.levels ?? osmLevels ?? '-';
  const shownYear = info.year_built || osmYear || '-';
  const shownArchitect = info.architect || osmArchitect || '-';
  const shownStyleRaw = info.style || osmStyle || '-';
  const shownStyle = shownStyleRaw === '-' ? '-' : (toHumanArchitectureStyle(shownStyleRaw) || shownStyleRaw);
  const shownDescription = osmDescription || '-';
  const shownExtraInfo = info.archimap_description || info.description || '-';
  const styleOptions = getArchitectureStyleOptions();
  const styleEditState = getArchitectureStyleEditState(info.style || osmStyle || '');
  const styleOptionsHtml = styleOptions
    .map((option) => `<option value="${escapeHtml(option.key)}" ${styleEditState.selectedKey === option.key ? 'selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('');
  const editableRows = canEditBuildings
    ? `
      <form id="building-edit-form" class="grid gap-2">
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <label for="building-name" class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalLabelName', null, 'Название:'))}</label>
          <input id="building-name" name="building-name" type="text" value="${escapeHtml(info.name || (shownName !== '-' ? shownName : ''))}" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <label for="building-levels" class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalLabelLevels', null, 'Этажей:'))}</label>
          <input id="building-levels" name="building-levels" type="number" value="${escapeHtml(info.levels ?? (shownLevels !== '-' ? shownLevels : ''))}" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <label for="building-year" class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalLabelYearBuilt', null, 'Год постройки:'))}</label>
          <input id="building-year" name="building-year" type="number" value="${escapeHtml(info.year_built || (shownYear !== '-' ? shownYear : ''))}" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <label for="building-architect" class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalLabelArchitect', null, 'Архитектор:'))}</label>
          <input id="building-architect" name="building-architect" type="text" value="${escapeHtml(info.architect || (shownArchitect !== '-' ? shownArchitect : ''))}" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <label for="building-style-select" class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalLabelStyle', null, 'Архитектурный стиль:'))}</label>
          <select id="building-style-select" name="building-style-select" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200">
            <option value="" ${styleEditState.selectedKey === '' ? 'selected' : ''}>${escapeHtml(t('modalStyleNotSet', null, 'Не указан'))}</option>
            ${styleOptionsHtml}
          </select>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <label for="building-archimap-description" class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalLabelExtraInfo', null, 'Доп. информация:'))}</label>
          <textarea id="building-archimap-description" name="building-archimap-description" rows="3" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200">${escapeHtml(info.archimap_description || info.description || '')}</textarea>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <div class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalAddressTagsTitle', null, 'Адрес (OSM теги):'))}</div>
          <div class="mt-1.5 grid gap-1.5 md:grid-cols-2">
            <label class="block md:col-span-2">
              <span class="mb-1 block text-xs font-semibold text-slate-700">${escapeHtml(t('modalAddressFull', null, 'Полный адрес (addr:full)'))}</span>
              <input id="building-addr-full" name="building-addr-full" type="text" value="${escapeHtml(addressForm.full)}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-slate-700">${escapeHtml(t('modalAddressPostcode', null, 'Индекс (addr:postcode)'))}</span>
              <input id="building-addr-postcode" name="building-addr-postcode" type="text" value="${escapeHtml(addressForm.postcode)}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-slate-700">${escapeHtml(t('modalAddressCity', null, 'Город (addr:city)'))}</span>
              <input id="building-addr-city" name="building-addr-city" type="text" value="${escapeHtml(addressForm.city)}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-slate-700">${escapeHtml(t('modalAddressPlace', null, 'Место/локация (addr:place)'))}</span>
              <input id="building-addr-place" name="building-addr-place" type="text" value="${escapeHtml(addressForm.place)}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-semibold text-slate-700">${escapeHtml(t('modalAddressStreet', null, 'Улица (addr:street)'))}</span>
              <input id="building-addr-street" name="building-addr-street" type="text" value="${escapeHtml(addressForm.street)}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
            </label>
            <label class="block md:col-span-2">
              <span class="mb-1 block text-xs font-semibold text-slate-700">${escapeHtml(t('modalAddressHouseNumber', null, 'Номер дома (addr:housenumber)'))}</span>
              <input id="building-addr-housenumber" name="building-addr-housenumber" type="text" value="${escapeHtml(addressForm.housenumber)}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
            </label>
          </div>
        </div>
        <div class="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
          <p id="building-save-status" class="text-sm text-slate-600"></p>
          <button type="submit" class="rounded-xl bg-indigo-600 px-3.5 py-1.5 text-sm font-semibold text-white transition hover:bg-indigo-700">${escapeHtml(t('modalSave', null, 'Сохранить'))}</button>
        </div>
      </form>
    `
    : `
      ${isAuthenticated ? `<div class="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">${escapeHtml(t('modalEditRestricted', null, 'Редактирование доступно только пользователям с разрешением администратора.'))}</div>` : ''}
      ${buildReadonlyField(t('modalLabelName', null, 'Название:'), escapeHtml(shownName))}
      ${buildReadonlyField(t('modalLabelAddress', null, 'Адрес:'), escapeHtml(shownAddress))}
      ${buildReadonlyField(t('modalLabelLevels', null, 'Этажей:'), escapeHtml(shownLevels))}
      ${buildReadonlyField(t('modalLabelYearBuilt', null, 'Год постройки:'), escapeHtml(shownYear))}
      ${buildReadonlyField(
        t('modalLabelArchitect', null, 'Архитектор:'),
        buildCopyChips(
          splitSemicolonValues(info.architect || osmArchitect).map((raw) => ({ raw, label: raw })),
          shownArchitect
        )
      )}
      ${buildReadonlyField(
        t('modalLabelStyle', null, 'Архитектурный стиль:'),
        buildCopyChips(
          splitSemicolonValues(info.style || osmStyle).map((raw) => ({
            raw,
            label: toHumanArchitectureStyle(raw) || raw
          })),
          shownStyle
        )
      )}
      ${buildReadonlyField(t('modalLabelDescription', null, 'Описание:'), escapeHtml(shownDescription))}
      ${buildReadonlyField(t('modalLabelExtraInfo', null, 'Доп. информация:'), escapeHtml(shownExtraInfo))}
    `;

  return `
    <div class="grid gap-2.5">
      ${editableRows}
      <details class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft">
        <summary class="relative cursor-pointer list-none bg-slate-50 px-3 py-2.5 pr-10 font-bold text-slate-900 transition hover:bg-slate-100 after:absolute after:right-3 after:top-1/2 after:-translate-y-1/2 after:content-['▾'] [&::-webkit-details-marker]:hidden [&[open]_summary]:after:rotate-180">${escapeHtml(t('modalOsmTagsSummary', null, 'OSM теги'))}</summary>
        <pre class="m-0 border-t border-slate-200 bg-white px-3 py-2.5 text-[11px] leading-5 text-slate-700 whitespace-pre-wrap break-words">${escapeHtml(JSON.stringify({
          osm: feature.properties?.osm_key || '-',
          ...osmTags
        }, null, 2))}</pre>
      </details>
    </div>
  `;
}

function getFeatureFocusLngLat(feature) {
  const coords = [];

  function collect(value) {
    if (!Array.isArray(value) || value.length === 0) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      coords.push([Number(value[0]), Number(value[1])]);
      return;
    }
    for (const item of value) collect(item);
  }

  const geometry = feature?.geometry;
  if (!geometry) return null;

  if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
    return [Number(geometry.coordinates[0]), Number(geometry.coordinates[1])];
  }

  collect(geometry.coordinates);
  if (coords.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of coords) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

function moveMapForModal(feature) {
  const center = getFeatureFocusLngLat(feature);
  if (!center) return;
  const width = map.getContainer().clientWidth || 0;
  const offsetX = -Math.round(width * 0.25);

  map.easeTo({
    center,
    offset: [offsetX, 0],
    duration: 450,
    essential: true
  });
}

function isModalOpen() {
  return !modalEl.classList.contains('hidden');
}

function openModal(feature, options = {}) {
  const historyMode = options.historyMode === 'replace' ? 'replace' : 'push';
  if (isMobileControlsPanelOpen()) {
    closeMobileControlsPanel();
  }
  modalContentEl.innerHTML = buildModalHtml(feature);
  const modalEditForm = document.getElementById('building-edit-form');
  if (modalEditForm) {
    modalEditForm.addEventListener('submit', saveBuildingInfoFromModal);
  }
  modalEl.classList.remove('hidden');
  modalEl.setAttribute('aria-hidden', 'false');
  moveMapForModal(feature);
  const parsed = parseKey(feature.properties?.osm_key);
  if (parsed) {
    writeBuildingToUrl(parsed.osmType, parsed.osmId, { mode: historyMode });
  }
}

function closeModal(options = {}) {
  const shouldUpdateUrl = options.updateUrl !== false;
  const historyMode = options.historyMode === 'push' ? 'push' : 'replace';
  modalEl.classList.add('hidden');
  modalEl.setAttribute('aria-hidden', 'true');
  if (shouldUpdateUrl) {
    clearBuildingFromUrl({ mode: historyMode });
  }
  selected = null;
  setSelectedFeature(null);
}

async function copyTextToClipboard(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(raw);
      return true;
    }
  } catch {
    // fall through to execCommand fallback
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = raw;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch {
    return false;
  }
}

let copyToastTimer = null;

function showCopyToast(message) {
  const text = String(message || '').trim() || t('copied', null, 'Скопировано');
  let toastEl = document.getElementById('copy-toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'copy-toast';
    toastEl.className = 'fixed bottom-4 left-1/2 z-[1400] -translate-x-1/2 rounded-lg bg-slate-900/95 px-3 py-2 text-xs font-semibold text-white shadow-lg opacity-0 pointer-events-none transition-opacity duration-200';
    document.body.appendChild(toastEl);
  }

  toastEl.textContent = text;
  toastEl.classList.remove('opacity-0');
  toastEl.classList.add('opacity-100');

  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => {
    toastEl.classList.remove('opacity-100');
    toastEl.classList.add('opacity-0');
  }, 1400);
}

function openAuthModal() {
  renderPasswordRecoveryPanels();
  if (!isRegistrationUiEnabled()) {
    setAuthTab('login');
  }
  authModalEl.classList.remove('hidden');
  authModalEl.setAttribute('aria-hidden', 'false');
}

function closeAuthModal() {
  authModalEl.classList.add('hidden');
  authModalEl.setAttribute('aria-hidden', 'true');
}

function readResetTokenFromUrl() {
  try {
    const url = new URL(window.location.href);
    const token = String(url.searchParams.get('resetToken') || '').trim();
    return token || null;
  } catch {
    return null;
  }
}

function readRegisterTokenFromUrl() {
  try {
    const url = new URL(window.location.href);
    const token = String(url.searchParams.get('registerToken') || '').trim();
    return token || null;
  } catch {
    return null;
  }
}

function clearResetTokenFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('resetToken')) return;
    url.searchParams.delete('resetToken');
    history.replaceState(null, '', url.toString());
  } catch {
    // ignore
  }
}

function clearRegisterTokenFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('registerToken')) return;
    url.searchParams.delete('registerToken');
    history.replaceState(null, '', url.toString());
  } catch {
    // ignore
  }
}

function setAuthTab(nextTab) {
  const tab = ['login', 'register'].includes(nextTab) ? nextTab : 'login';
  if (authLoginPanelEl) authLoginPanelEl.classList.toggle('hidden', tab !== 'login');
  if (registerPanelEl) registerPanelEl.classList.toggle('hidden', tab !== 'register' || !isRegistrationUiEnabled());
  if (forgotPasswordPanelEl && tab !== 'login') forgotPasswordPanelEl.classList.add('hidden');

  const ui = window.ArchiMapUI || null;
  const applyTabStyle = (el, active) => {
    if (!el) return;
    if (ui && typeof ui.tabButtonClass === 'function') {
      el.className = ui.tabButtonClass(active);
      return;
    }
    el.className = active
      ? 'ui-tab-btn ui-tab-btn-active'
      : 'ui-tab-btn';
  };
  applyTabStyle(authTabLoginEl, tab === 'login');
  applyTabStyle(authTabRegisterEl, tab === 'register');
}

function renderRegistrationVerifyPanel() {
  if (!registerVerifyPanelEl) return;
  const visible = Boolean(pendingRegistrationEmail);
  registerVerifyPanelEl.classList.toggle('hidden', !visible);
  if (!visible) return;
  if (registerVerifyHintEl) {
    registerVerifyHintEl.textContent = t(
      'authRegisterVerifyHint',
      { email: pendingRegistrationEmail },
      `Мы отправили письмо на ${pendingRegistrationEmail}. Подтвердите регистрацию ссылкой из письма или введите код ниже.`
    );
  }
}

function renderPasswordRecoveryPanels() {
  if (resetPasswordPanelEl) {
    if (pendingResetToken) {
      resetPasswordPanelEl.classList.remove('hidden');
    } else {
      resetPasswordPanelEl.classList.add('hidden');
    }
  }
  renderRegistrationVerifyPanel();
}

async function confirmRegistrationByToken(token) {
  const value = String(token || '').trim();
  if (!value) return false;
  let resp;
  try {
    resp = await fetch('/api/register/confirm-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: value })
    });
  } catch {
    if (registerVerifyStatusEl) registerVerifyStatusEl.textContent = t('authRegisterLinkNetworkError', null, 'Ошибка сети при подтверждении ссылки');
    return false;
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (registerVerifyStatusEl) registerVerifyStatusEl.textContent = String(data?.error || t('authRegisterLinkFailed', null, 'Не удалось подтвердить регистрацию'));
    return false;
  }

  isAuthenticated = true;
  currentUser = data?.user || null;
  isAdmin = Boolean(currentUser?.isAdmin);
  isMasterAdmin = Boolean(currentUser?.isMasterAdmin);
  canEditBuildings = Boolean(currentUser?.canEditBuildings || isAdmin);
  csrfToken = String(data?.csrfToken || '') || csrfToken;
  pendingRegistrationEmail = null;
  pendingRegisterToken = null;
  clearRegisterTokenFromUrl();
  renderAuth();
  return true;
}

function openProfileModal() {
  if (!isAuthenticated || !profileModalEl) return;
  profileModalEl.classList.remove('hidden');
  profileModalEl.setAttribute('aria-hidden', 'false');
}

function closeProfileModal() {
  if (!profileModalEl) return;
  profileModalEl.classList.add('hidden');
  profileModalEl.setAttribute('aria-hidden', 'true');
}

function openSearchModal(prefill = '') {
  if (!searchModalEl) return;
  searchModalEl.classList.remove('hidden');
  searchModalEl.setAttribute('aria-hidden', 'false');
  if (searchModalInputEl) {
    const text = String(prefill || '').trim();
    searchModalInputEl.value = text;
    const isMobileViewport = window.matchMedia ? window.matchMedia('(max-width: 767px)').matches : false;
    if (isMobileViewport) {
      setTimeout(() => searchModalInputEl.focus(), 0);
    }
  }
}

function closeSearchModal() {
  if (!searchModalEl) return;
  searchModalEl.classList.add('hidden');
  searchModalEl.setAttribute('aria-hidden', 'true');
}

function buildSearchCacheKey(query, center, cursor = 0) {
  const q = String(query || '').trim().toLowerCase();
  const lon = Number(center?.lng || 0).toFixed(3);
  const lat = Number(center?.lat || 0).toFixed(3);
  return `${q}|${lon}|${lat}|${SEARCH_RESULTS_LIMIT}|${Number(cursor) || 0}`;
}

function getSearchCache(key) {
  const entry = buildingSearchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > SEARCH_CACHE_TTL_MS) {
    buildingSearchCache.delete(key);
    return null;
  }
  return entry.items;
}

function setSearchCache(key, items) {
  if (!key) return;
  buildingSearchCache.set(key, {
    ts: Date.now(),
    items
  });
  if (buildingSearchCache.size > 120) {
    const firstKey = buildingSearchCache.keys().next().value;
    if (firstKey != null) buildingSearchCache.delete(firstKey);
  }
}

function debounce(fn, delayMs) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

function renderSearchSkeleton(count = 6) {
  if (!searchResultsListEl) return;
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    parts.push(`
      <div class="animate-pulse rounded-2xl border border-slate-200 bg-white p-3 shadow-soft">
        <div class="mb-2 h-4 w-2/3 rounded bg-slate-200"></div>
        <div class="mb-1 h-3 w-4/5 rounded bg-slate-200"></div>
        <div class="h-3 w-3/5 rounded bg-slate-200"></div>
      </div>
    `);
  }
  searchResultsListEl.innerHTML = parts.join('');
}

function renderSearchResults(items, options = {}) {
  const { hasMore = false, loadingMore = false } = options;
  if (!searchResultsListEl || !searchResultsStatusEl) return;
  const data = Array.isArray(items) ? items : [];
  if (data.length === 0) {
    searchResultsStatusEl.textContent = t('searchNoResults', null, 'Ничего не найдено.');
    searchResultsListEl.innerHTML = '';
    updateSearchMarkers([]);
    if (searchLoadMoreBtnEl) {
      searchLoadMoreBtnEl.classList.add('hidden');
      searchLoadMoreBtnEl.disabled = false;
      searchLoadMoreBtnEl.textContent = t('searchShowMore', null, 'Показать ещё');
    }
    return;
  }

  searchResultsStatusEl.textContent = t('searchFoundCount', { count: data.length }, `Найдено: ${data.length}`);
  searchResultsListEl.innerHTML = data.map((item) => {
    const title = item.name || t('searchUntitled', null, 'Без названия');
    const shownStyle = toHumanArchitectureStyle(item.style) || item.style || null;
    const line2 = [
      item.address ? t('searchLineAddress', { value: item.address }, `Адрес: ${item.address}`) : null,
      shownStyle ? t('searchLineStyle', { value: shownStyle }, `Стиль: ${shownStyle}`) : null
    ].filter(Boolean).join(' • ');
    const line3 = item.architect ? t('searchLineArchitect', { value: item.architect }, `Архитектор: ${item.architect}`) : '';

    return `
      <article class="rounded-2xl border border-slate-200 bg-white p-3 shadow-soft">
        <div class="mb-1 text-sm font-semibold text-slate-900">${escapeHtml(title)}</div>
        ${line2 ? `<div class="mb-1 text-xs text-slate-700">${escapeHtml(line2)}</div>` : ''}
        ${line3 ? `<div class="mb-2 text-xs text-slate-700">${escapeHtml(line3)}</div>` : '<div class="mb-2"></div>'}
        <div class="flex items-center justify-between gap-2">
          <div class="text-[11px] text-slate-500">${escapeHtml(`${item.osmType}/${item.osmId}`)}</div>
          <button data-action="go-to-building" data-osm-type="${escapeHtml(item.osmType)}" data-osm-id="${escapeHtml(item.osmId)}" type="button" class="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">
            ${escapeHtml(t('searchGoToBuilding', null, 'К зданию'))}
          </button>
        </div>
      </article>
    `;
  }).join('');

  if (searchLoadMoreBtnEl) {
    if (hasMore) {
      searchLoadMoreBtnEl.classList.remove('hidden');
      searchLoadMoreBtnEl.disabled = loadingMore;
      searchLoadMoreBtnEl.textContent = loadingMore
        ? t('searchLoading', null, 'Загрузка...')
        : t('searchShowMore', null, 'Показать ещё');
    } else {
      searchLoadMoreBtnEl.classList.add('hidden');
      searchLoadMoreBtnEl.disabled = false;
      searchLoadMoreBtnEl.textContent = t('searchShowMore', null, 'Показать ещё');
    }
  }
}

function resetSearchState() {
  searchState = {
    query: '',
    center: null,
    items: [],
    hasMore: false,
    nextCursor: null
  };
  updateSearchMarkers([]);
}

async function runBuildingSearch(query, options = {}) {
  const { append = false } = options;
  const text = String(query || '').trim().slice(0, 120);
  const styleSearchKey = resolveArchitectureStyleSearchKey(text);
  const styleSearchKeys = resolveArchitectureStyleSearchKeys(text);
  const searchQuery = String(styleSearchKey || text).slice(0, 120);
  if (!searchResultsStatusEl || !searchResultsListEl) return;
  if (text.length < 2) {
    resetSearchState();
    searchResultsStatusEl.textContent = t('searchMinChars', null, 'Введите минимум 2 символа.');
    searchResultsListEl.innerHTML = '';
    if (searchLoadMoreBtnEl) searchLoadMoreBtnEl.classList.add('hidden');
    return;
  }

  const center = append && searchState.center ? searchState.center : map.getCenter();
  const cursor = append ? Number(searchState.nextCursor || 0) : 0;
  if (append && !searchState.hasMore) return;
  const hasStyleDictionaryMatch = styleSearchKeys.length > 0;
  if (!append) {
    searchState = {
      query: text,
      center,
      items: [],
      hasMore: false,
      nextCursor: null
    };
  }

  if (hasStyleDictionaryMatch) {
    const token = ++activeSearchRequestToken;
    if (!append) {
      searchResultsStatusEl.textContent = t('searchInProgress', null, 'Ищем по базе...');
      renderSearchSkeleton(6);
    }
    try {
      const keysToQuery = styleSearchKeys.slice(0, 5);
      const chunks = await Promise.all(keysToQuery.map((key) => fetchBuildingSearchChunk(key, center, 0)));
      if (token !== activeSearchRequestToken) return;
      const merged = dedupeSearchItems(chunks.flatMap((chunk) => chunk.items));
      const filtered = filterSearchItemsByStyleKeys(merged, styleSearchKeys);
      searchState.items = filtered.slice(0, SEARCH_RESULTS_LIMIT);
      searchState.query = text;
      searchState.center = center;
      searchState.hasMore = false;
      searchState.nextCursor = null;
      renderSearchResults(searchState.items, { hasMore: false });
      updateSearchMarkers(searchState.items);
      fitMapToSearchResults(searchState.items);
      return;
    } catch (error) {
      if (token !== activeSearchRequestToken) return;
      searchResultsStatusEl.textContent = String(error?.message || t('searchFailed', null, 'Не удалось выполнить поиск.'));
      if (!append) {
        searchResultsListEl.innerHTML = '';
        updateSearchMarkers([]);
      }
      if (searchLoadMoreBtnEl) searchLoadMoreBtnEl.classList.add('hidden');
      return;
    }
  }

  const cacheKey = buildSearchCacheKey(searchQuery, center, cursor);
  const cached = getSearchCache(cacheKey);
  if (cached) {
    const cachedItems = filterSearchItemsByStyleKey(cached.items, styleSearchKey);
    if (append) {
      searchState.items = searchState.items.concat(cachedItems);
    } else {
      searchState.items = cachedItems;
    }
    searchState.hasMore = Boolean(cached.hasMore);
    searchState.nextCursor = Number.isFinite(cached.nextCursor) ? Number(cached.nextCursor) : null;
    renderSearchResults(searchState.items, { hasMore: searchState.hasMore });
    updateSearchMarkers(searchState.items);
    fitMapToSearchResults(searchState.items);
    return;
  }

  const token = ++activeSearchRequestToken;
  if (append) {
    searchResultsStatusEl.textContent = t(
      'searchFoundCount',
      { count: searchState.items.length },
      `Найдено: ${searchState.items.length}`
    );
    renderSearchResults(searchState.items, { hasMore: true, loadingMore: true });
  } else {
    searchResultsStatusEl.textContent = t('searchInProgress', null, 'Ищем по базе...');
    renderSearchSkeleton(6);
  }

  const params = new URLSearchParams({
    q: searchQuery,
    lon: String(center.lng ?? center.lon ?? 0),
    lat: String(center.lat),
    limit: String(SEARCH_RESULTS_LIMIT)
  });
  if (cursor > 0) params.set('cursor', String(cursor));

  try {
    const resp = await fetch(`/api/search-buildings?${params.toString()}`);
    if (token !== activeSearchRequestToken) return;
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: t('searchError', null, 'Ошибка поиска') }));
      searchResultsStatusEl.textContent = err.error || t('searchError', null, 'Ошибка поиска');
      if (append) {
        renderSearchResults(searchState.items, { hasMore: searchState.hasMore });
      } else {
        searchResultsListEl.innerHTML = '';
        updateSearchMarkers([]);
        if (searchLoadMoreBtnEl) searchLoadMoreBtnEl.classList.add('hidden');
      }
      return;
    }

    const data = await resp.json().catch(() => ({ items: [], hasMore: false, nextCursor: null }));
    const items = filterSearchItemsByStyleKey(data.items, styleSearchKey);
    const hasMore = Boolean(data.hasMore);
    const nextCursor = Number.isFinite(data.nextCursor) ? Number(data.nextCursor) : null;
    setSearchCache(cacheKey, { items, hasMore, nextCursor });

    if (append) {
      searchState.items = searchState.items.concat(items);
    } else {
      searchState.items = items;
    }
    searchState.query = text;
    searchState.center = center;
    searchState.hasMore = hasMore;
    searchState.nextCursor = nextCursor;
    renderSearchResults(searchState.items, { hasMore: searchState.hasMore });
    updateSearchMarkers(searchState.items);
    fitMapToSearchResults(searchState.items);
  } catch {
    if (token !== activeSearchRequestToken) return;
    searchResultsStatusEl.textContent = t('searchFailed', null, 'Не удалось выполнить поиск.');
    if (append) {
      if (searchLoadMoreBtnEl) {
        searchLoadMoreBtnEl.classList.remove('hidden');
        searchLoadMoreBtnEl.disabled = false;
        searchLoadMoreBtnEl.textContent = t('searchShowMore', null, 'Показать ещё');
      }
    } else {
      searchResultsListEl.innerHTML = '';
      updateSearchMarkers([]);
      if (searchLoadMoreBtnEl) searchLoadMoreBtnEl.classList.add('hidden');
    }
  }
}

const runBuildingSearchDebounced = debounce((text) => {
  runBuildingSearch(text, { append: false });
}, 320);

function formatChangeValue(value) {
  if (value == null || value === '') return '—';
  return String(value);
}

function formatUpdatedAt(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('ru-RU');
}

function setSelectedFeature(feature) {
  const source = map.getSource('selected-building');
  if (!source) return;
  source.setData({
    type: 'FeatureCollection',
    features: feature ? [feature] : []
  });
}

function getSearchItemPoint(item) {
  const lon = Number(item?.lon);
  const lat = Number(item?.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return [lon, lat];
}

function buildSearchMarkersGeojson(items) {
  const features = [];
  for (const item of Array.isArray(items) ? items : []) {
    const point = getSearchItemPoint(item);
    if (!point) continue;
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: point
      },
      properties: {
        osm_key: `${String(item?.osmType || '')}/${String(item?.osmId || '')}`
      }
    });
  }
  return {
    type: 'FeatureCollection',
    features
  };
}

function updateSearchMarkers(items) {
  searchMarkersGeojson = buildSearchMarkersGeojson(items);
  const source = map.getSource(SEARCH_RESULTS_SOURCE_ID);
  if (!source) return;
  source.setData(searchMarkersGeojson);
}

function fitMapToSearchResults(items) {
  const points = (Array.isArray(items) ? items : [])
    .map((item) => getSearchItemPoint(item))
    .filter(Boolean);
  if (points.length === 0) return;

  const desktopMedia = window.matchMedia ? window.matchMedia('(min-width: 768px)') : null;
  const isDesktop = Boolean(desktopMedia && desktopMedia.matches);
  const isSearchModalOpen = Boolean(searchModalEl && !searchModalEl.classList.contains('hidden'));

  if (points.length === 1) {
    const singlePointOptions = {
      center: points[0],
      zoom: Math.max(map.getZoom(), 16),
      duration: 450,
      essential: true
    };

    if (!isDesktop && isSearchModalOpen) {
      const searchPanel = searchModalEl.firstElementChild;
      const panelRect = searchPanel?.getBoundingClientRect?.();
      const panelTop = Number(panelRect?.top);
      const visibleTopHalfCenterY = Number.isFinite(panelTop)
        ? Math.max(40, Math.round(panelTop / 2))
        : Math.round(window.innerHeight * 0.24);
      const offsetY = Math.round(visibleTopHalfCenterY - (window.innerHeight / 2));
      singlePointOptions.offset = [0, offsetY];
    }

    map.easeTo({
      ...singlePointOptions
    });
    return;
  }

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }

  const padding = { top: 72, right: 28, bottom: 28, left: 28 };

  if (isDesktop) {
    if (searchModalEl && !searchModalEl.classList.contains('hidden')) {
      const searchPanel = searchModalEl.firstElementChild;
      const width = Number(searchPanel?.getBoundingClientRect?.().width || 0);
      if (Number.isFinite(width) && width > 0) {
        padding.left = Math.max(padding.left, Math.round(width) + 28);
      }
    }
    if (modalEl && !modalEl.classList.contains('hidden')) {
      const modalPanel = modalEl.firstElementChild;
      const width = Number(modalPanel?.getBoundingClientRect?.().width || 0);
      if (Number.isFinite(width) && width > 0) {
        padding.right = Math.max(padding.right, Math.round(width) + 28);
      }
    }
  } else if (isSearchModalOpen) {
    const searchPanel = searchModalEl.firstElementChild;
    const panelRect = searchPanel?.getBoundingClientRect?.();
    const coveredBottom = Number.isFinite(Number(panelRect?.height))
      ? Number(panelRect.height)
      : Math.round(window.innerHeight * 0.5);
    padding.top = Math.max(24, Math.round(window.innerHeight * 0.08));
    padding.bottom = Math.max(coveredBottom + 24, Math.round(window.innerHeight * 0.54));
    padding.left = 20;
    padding.right = 20;
  }

  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
    padding,
    duration: 500,
    maxZoom: 16.5,
    essential: true
  });
}

async function selectBuildingFeature(feature, options = {}) {
  const historyMode = options.historyMode === 'replace' ? 'replace' : 'push';
  normalizeFeatureInfo(feature);
  const parsed = parseKey(feature.properties?.osm_key);
  if (!parsed) return;

  selected = {
    ...parsed,
    feature
  };

  setSelectedFeature(feature);
  closeSearchModal();
  openModal(feature, { historyMode });
}

async function syncSelectedBuildingWithUrl() {
  const buildingFromUrl = readBuildingFromUrl();
  if (!buildingFromUrl) {
    if (selected || isModalOpen()) {
      closeModal({ updateUrl: false });
    }
    return;
  }

  if (
    selected &&
    selected.osmType === buildingFromUrl.osmType &&
    String(selected.osmId) === String(buildingFromUrl.osmId) &&
    selected.feature
  ) {
    if (!isModalOpen()) {
      openModal(selected.feature, { historyMode: 'replace' });
    }
    return;
  }

  const syncSeq = ++urlSelectionSyncSeq;
  const feature = await fetchBuildingById(buildingFromUrl.osmType, buildingFromUrl.osmId);
  if (syncSeq !== urlSelectionSyncSeq) return;

  if (!feature) {
    closeModal({ updateUrl: false });
    return;
  }

  await selectBuildingFeature(feature, { historyMode: 'replace' });
}

async function loadBuildingsByViewport() {
  const loadSeq = ++visibleBuildingsLoadSeq;
  updateCartoBuildingsVisibility();
  if (!map.getSource('local-buildings')) {
    setHoveredBuilding(null);
    return;
  }

  if (map.getZoom() < MIN_BUILDING_ZOOM) {
    setHoveredBuilding(null);
    currentBuildingsGeojson = { type: 'FeatureCollection', features: [] };
    for (const key of currentVisibleBuildingKeys) {
      filterFeatureStateCache.delete(key);
      setLocalBuildingFeatureState(key, { isFiltered: false });
    }
    currentVisibleBuildingKeys = new Set();
    refreshTagKeysDatalist();
    applyFiltersToCurrentData();
    return;
  }

  if (!shouldProcessVisibleBuildings()) {
    setHoveredBuilding(null);
    currentBuildingsGeojson = { type: 'FeatureCollection', features: [] };
    for (const key of currentVisibleBuildingKeys) {
      filterFeatureStateCache.delete(key);
      setLocalBuildingFeatureState(key, { isFiltered: false, hasExtraInfo: false });
    }
    currentVisibleBuildingKeys = new Set();
    if (filterStatusEl) {
      filterStatusEl.textContent = t('filterInactive', null, 'Фильтр не активен.');
    }
    return;
  }

  await prefetchFilterDataByViewportBounds();
  if (loadSeq !== visibleBuildingsLoadSeq) return;
  const features = getVisibleBuildingsSnapshot();
  await hydrateVisibleBuildingsForFiltering(features, loadSeq);
  if (loadSeq !== visibleBuildingsLoadSeq) return;
  currentBuildingsGeojson = { type: 'FeatureCollection', features };
  refreshTagKeysDatalist();
  applyFiltersToCurrentData();
}

async function fetchBuildingById(osmType, osmId) {
  const resp = await fetch(`/api/building/${osmType}/${osmId}`);
  if (!resp.ok) return null;
  return resp.json();
}

function scheduleLoadBuildings() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    loadBuildingsByViewport();
  }, 180);
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  let resp;
  try {
    resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
  } catch {
    authStatusEl.textContent = t('authError', null, 'Ошибка авторизации');
    return;
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    authStatusEl.textContent = String(err?.error || t('authError', null, 'Ошибка авторизации'));
    return;
  }

  const data = await resp.json().catch(() => ({ user: null }));
  isAuthenticated = true;
  currentUser = data?.user || null;
  isAdmin = Boolean(currentUser?.isAdmin);
  isMasterAdmin = Boolean(currentUser?.isMasterAdmin);
  canEditBuildings = Boolean(currentUser?.canEditBuildings || isAdmin);
  csrfToken = String(data?.csrfToken || '') || csrfToken;
  renderAuth();
  closeAuthModal();
  const nextPath = readRequestedPostLoginPath();
  if (nextPath) {
    window.location.href = nextPath;
  }
});

if (registerFormEl && isRegistrationUiEnabled()) {
  registerFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();

    const firstName = String(registerFirstNameEl?.value || '').trim();
    const lastName = String(registerLastNameEl?.value || '').trim();
    const email = String(registerEmailEl?.value || '').trim();
    const password = String(registerPasswordEl?.value || '');
    const passwordConfirm = String(registerPasswordConfirmEl?.value || '');

    if (!email || !password) {
      if (registerStatusEl) registerStatusEl.textContent = t('authRegisterFillRequired', null, 'Заполните email и пароль');
      return;
    }
    if (password !== passwordConfirm) {
      if (registerStatusEl) registerStatusEl.textContent = t('authRegisterPasswordMismatch', null, 'Пароли не совпадают');
      return;
    }

    if (registerStatusEl) registerStatusEl.textContent = t('authRegisterSendingMail', null, 'Отправляем письмо для подтверждения...');
    let resp;
    try {
      resp = await fetch('/api/register/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, email, password })
      });
    } catch {
      if (registerStatusEl) registerStatusEl.textContent = t('authRegisterNetworkError', null, 'Ошибка сети при отправке письма');
      return;
    }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (registerStatusEl) registerStatusEl.textContent = String(data?.error || t('authRegisterSendFailed', null, 'Не удалось отправить письмо'));
      return;
    }

    if (Boolean(data?.directSignup) && data?.user) {
      if (registerStatusEl) registerStatusEl.textContent = t('authRegisterCompleted', null, 'Регистрация завершена');
      pendingRegistrationEmail = null;
      pendingRegisterToken = null;
      clearRegisterTokenFromUrl();
      isAuthenticated = true;
      currentUser = data.user;
      isAdmin = Boolean(currentUser?.isAdmin);
      isMasterAdmin = Boolean(currentUser?.isMasterAdmin);
      canEditBuildings = Boolean(currentUser?.canEditBuildings || isAdmin);
      csrfToken = String(data?.csrfToken || '') || csrfToken;
      renderAuth();
      closeAuthModal();
      window.location.href = '/account/';
      return;
    }

    pendingRegistrationEmail = email;
    renderPasswordRecoveryPanels();
    if (registerVerifyStatusEl) registerVerifyStatusEl.textContent = '';
    if (registerVerifyCodeEl) registerVerifyCodeEl.value = '';
    if (registerVerifyCodeEl) registerVerifyCodeEl.focus();
    if (registerStatusEl) {
      const ttl = Number(data?.expiresInMinutes);
      registerStatusEl.textContent = Number.isFinite(ttl)
        ? t('authRegisterMailSentTtl', { ttl }, `Письмо отправлено. Код действителен ${ttl} минут.`)
        : t('authRegisterMailSent', null, 'Письмо отправлено.');
    }
  });
}

if (registerVerifyFormEl && isRegistrationUiEnabled()) {
  registerVerifyFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = String(pendingRegistrationEmail || '').trim();
    const code = String(registerVerifyCodeEl?.value || '').replace(/\D/g, '').slice(0, 6);
    if (registerVerifyCodeEl) registerVerifyCodeEl.value = code;
    if (!email || !code) {
      if (registerVerifyStatusEl) registerVerifyStatusEl.textContent = t('authRegisterCodeRequired', null, 'Введите код из письма');
      return;
    }
    if (registerVerifyStatusEl) registerVerifyStatusEl.textContent = t('authRegisterConfirming', null, 'Подтверждаем регистрацию...');

    let resp;
    try {
      resp = await fetch('/api/register/confirm-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code })
      });
    } catch {
      if (registerVerifyStatusEl) registerVerifyStatusEl.textContent = t('authRegisterConfirmNetworkError', null, 'Ошибка сети при подтверждении');
      return;
    }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (registerVerifyStatusEl) registerVerifyStatusEl.textContent = String(data?.error || t('authRegisterConfirmFailed', null, 'Не удалось завершить регистрацию'));
      return;
    }

    if (registerVerifyStatusEl) registerVerifyStatusEl.textContent = t('authRegisterCompleted', null, 'Регистрация завершена');
    pendingRegistrationEmail = null;
    pendingRegisterToken = null;
    clearRegisterTokenFromUrl();
    isAuthenticated = true;
    currentUser = data?.user || null;
    isAdmin = Boolean(currentUser?.isAdmin);
    isMasterAdmin = Boolean(currentUser?.isMasterAdmin);
    canEditBuildings = Boolean(currentUser?.canEditBuildings || isAdmin);
    csrfToken = String(data?.csrfToken || '') || csrfToken;
    renderAuth();
    closeAuthModal();
    window.location.href = '/account/';
  });
}

if (forgotPasswordFormEl) {
  forgotPasswordFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = String(forgotPasswordEmailEl?.value || '').trim();
    if (!email) {
      if (forgotPasswordStatusEl) forgotPasswordStatusEl.textContent = t('authForgotEmailRequired', null, 'Укажите email');
      return;
    }
    if (forgotPasswordStatusEl) forgotPasswordStatusEl.textContent = t('authForgotSending', null, 'Отправляем ссылку...');
    let resp;
    try {
      resp = await fetch('/api/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
    } catch {
      if (forgotPasswordStatusEl) forgotPasswordStatusEl.textContent = t('authForgotNetworkError', null, 'Ошибка сети');
      return;
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (forgotPasswordStatusEl) forgotPasswordStatusEl.textContent = String(data?.error || t('authForgotFailed', null, 'Не удалось отправить письмо'));
      return;
    }
    if (forgotPasswordStatusEl) forgotPasswordStatusEl.textContent = t('authForgotDone', null, 'Если аккаунт существует, ссылка отправлена на почту.');
  });
}

if (resetPasswordFormEl) {
  resetPasswordFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pendingResetToken) {
      if (resetPasswordStatusEl) resetPasswordStatusEl.textContent = t('authResetTokenMissing', null, 'Токен сброса не найден в ссылке.');
      return;
    }
    const nextPassword = String(resetPasswordNewEl?.value || '');
    const confirmPassword = String(resetPasswordConfirmEl?.value || '');
    if (!nextPassword || !confirmPassword) {
      if (resetPasswordStatusEl) resetPasswordStatusEl.textContent = t('authResetFillBoth', null, 'Заполните оба поля пароля');
      return;
    }
    if (nextPassword !== confirmPassword) {
      if (resetPasswordStatusEl) resetPasswordStatusEl.textContent = t('authResetPasswordsMismatch', null, 'Пароли не совпадают');
      return;
    }

    if (resetPasswordStatusEl) resetPasswordStatusEl.textContent = t('authResetSaving', null, 'Сохраняем новый пароль...');
    let resp;
    try {
      resp = await fetch('/api/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: pendingResetToken, newPassword: nextPassword })
      });
    } catch {
      if (resetPasswordStatusEl) resetPasswordStatusEl.textContent = t('authResetNetworkError', null, 'Ошибка сети');
      return;
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (resetPasswordStatusEl) resetPasswordStatusEl.textContent = String(data?.error || t('authResetFailed', null, 'Не удалось сменить пароль'));
      return;
    }

    pendingResetToken = null;
    clearResetTokenFromUrl();
    renderPasswordRecoveryPanels();
    if (resetPasswordStatusEl) resetPasswordStatusEl.textContent = t('authResetDone', null, 'Пароль обновлен. Войдите с новым паролем.');
    resetPasswordFormEl.reset();
  });
}

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  isAuthenticated = false;
  isAdmin = false;
  isMasterAdmin = false;
  currentUser = null;
  canEditBuildings = false;
  csrfToken = null;
  renderAuth();
});

if (settingsLogoutBtnEl) {
  settingsLogoutBtnEl.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    isAuthenticated = false;
    isAdmin = false;
    isMasterAdmin = false;
    currentUser = null;
    canEditBuildings = false;
    csrfToken = null;
    renderAuth();
    closeMobileControlsPanel();
  });
}

if (profileFormEl) {
  profileFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const firstName = String(profileFirstNameEl?.value || '').trim();
    const lastName = String(profileLastNameEl?.value || '').trim();
    if (profileStatusEl) profileStatusEl.textContent = t('accountProfileSaving', null, 'Сохраняем профиль...');

    let resp;
    try {
      resp = await fetch('/api/account/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName })
      });
    } catch {
      if (profileStatusEl) profileStatusEl.textContent = t('accountProfileNetworkError', null, 'Ошибка сети');
      return;
    }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (profileStatusEl) profileStatusEl.textContent = String(data?.error || t('accountProfileSaveFailed', null, 'Не удалось сохранить профиль'));
      return;
    }

    currentUser = data?.user || currentUser;
    if (profileStatusEl) profileStatusEl.textContent = t('accountProfileSaved', null, 'Профиль сохранён');
    renderAuth();
  });
}

if (changePasswordFormEl) {
  changePasswordFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const currentPassword = String(document.getElementById('current-password')?.value || '');
    const newPassword = String(document.getElementById('new-password')?.value || '');
    const newPasswordConfirm = String(document.getElementById('new-password-confirm')?.value || '');

    if (!currentPassword || !newPassword || !newPasswordConfirm) {
      if (changePasswordStatusEl) changePasswordStatusEl.textContent = t('accountChangePasswordFillAll', null, 'Заполните все поля');
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      if (changePasswordStatusEl) changePasswordStatusEl.textContent = t('accountChangePasswordMismatch', null, 'Новый пароль и подтверждение не совпадают');
      return;
    }

    if (changePasswordStatusEl) changePasswordStatusEl.textContent = t('accountChangePasswordSaving', null, 'Сохраняем новый пароль...');
    let resp;
    try {
      resp = await fetch('/api/account/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
    } catch {
      if (changePasswordStatusEl) changePasswordStatusEl.textContent = t('accountPasswordNetworkError', null, 'Ошибка сети');
      return;
    }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (changePasswordStatusEl) changePasswordStatusEl.textContent = String(data?.error || t('accountPasswordFailed', null, 'Не удалось сменить пароль'));
      return;
    }

    if (changePasswordStatusEl) changePasswordStatusEl.textContent = t('accountChangePasswordDone', null, 'Пароль успешно обновлён');
    changePasswordFormEl.reset();
  });
}

if (profileLogoutBtnEl) {
  profileLogoutBtnEl.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    isAuthenticated = false;
    isAdmin = false;
    isMasterAdmin = false;
    currentUser = null;
    canEditBuildings = false;
    csrfToken = null;
    closeProfileModal();
    renderAuth();
  });
}

if (searchFormEl) {
  searchFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = String(searchInputEl?.value || '').trim().slice(0, 120);
    openSearchModal(text);
    await runBuildingSearch(text, { append: false });
  });
}

if (searchInputEl) {
  searchInputEl.addEventListener('input', () => {
    const text = String(searchInputEl.value || '').slice(0, 120);
    searchInputEl.value = text;
    if (searchModalInputEl) searchModalInputEl.value = text;
    if (String(text).trim() !== '') return;
    resetSearchState();
    if (searchResultsListEl) searchResultsListEl.innerHTML = '';
    if (searchResultsStatusEl) {
      searchResultsStatusEl.textContent = t('searchMinChars', null, 'Введите минимум 2 символа.');
    }
    if (searchLoadMoreBtnEl) searchLoadMoreBtnEl.classList.add('hidden');
  });
}

if (searchMobileBtnEl) {
  searchMobileBtnEl.addEventListener('click', () => {
    const text = String(searchInputEl?.value || searchModalInputEl?.value || '').trim().slice(0, 120);
    openSearchModal(text);
    if (text.length >= 2) {
      runBuildingSearch(text);
    }
  });
}

if (searchModalFormEl) {
  searchModalFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = String(searchModalInputEl?.value || '').trim().slice(0, 120);
    if (searchInputEl) searchInputEl.value = text;
    if (searchModalInputEl) searchModalInputEl.value = text;
    await runBuildingSearch(text, { append: false });
  });
}

if (searchModalInputEl) {
  searchModalInputEl.addEventListener('input', () => {
    const text = String(searchModalInputEl.value || '').slice(0, 120);
    searchModalInputEl.value = text;
    if (searchInputEl) searchInputEl.value = text;
    runBuildingSearchDebounced(text);
  });
}

if (searchLoadMoreBtnEl) {
  searchLoadMoreBtnEl.addEventListener('click', async () => {
    await runBuildingSearch(searchState.query || String(searchModalInputEl?.value || searchInputEl?.value || '').trim(), { append: true });
  });
}

if (searchResultsListEl) {
  searchResultsListEl.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('[data-action="go-to-building"]');
    if (!button) return;
    const osmType = String(button.getAttribute('data-osm-type') || '').trim();
    const osmId = Number(button.getAttribute('data-osm-id'));
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) return;

    button.disabled = true;
    try {
      const feature = await fetchBuildingById(osmType, osmId);
      if (!feature) return;
      normalizeFeatureInfo(feature);
      await selectBuildingFeature(feature);
      closeSearchModal();
    } finally {
      button.disabled = false;
    }
  });
}

if (filterToggleBtnEl) {
  filterToggleBtnEl.addEventListener('click', toggleFilterPanel);
  setFilterToggleButtonState(isFilterPanelOpen());
}
if (mobileControlsToggleBtnEl) {
  mobileControlsToggleBtnEl.addEventListener('click', toggleMobileControlsPanel);
  setMobileControlsToggleButtonState(isMobileControlsPanelOpen());
}
if (filterCloseBtnEl) {
  filterCloseBtnEl.addEventListener('click', closeFilterPanel);
}
if (filterAddRowBtnEl) {
  filterAddRowBtnEl.addEventListener('click', addFilterRow);
}
if (filterResetBtnEl) {
  filterResetBtnEl.addEventListener('click', resetFilterRows);
}
if (filterRowsEl) {
  filterRowsEl.addEventListener('input', onFilterRowsChange);
  filterRowsEl.addEventListener('change', onFilterRowsChange);
  filterRowsEl.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-action="remove"]');
    if (!button) return;
    const row = button.closest('[data-filter-row]');
    if (!row) return;
    row.remove();
    if (filterRowsEl.children.length === 0) addFilterRow();
    applyFiltersToCurrentData();
  });
}
if (labelsToggleEl) {
  labelsToggleEl.addEventListener('change', () => {
    applyLabelsHidden(Boolean(labelsToggleEl.checked), { persist: true });
  });
  const savedLabelsHidden = getSavedLabelsHidden();
  applyLabelsHidden(savedLabelsHidden == null ? false : savedLabelsHidden, { persist: false });
}
if (themeToggleEl) {
  applyTheme(getCurrentTheme(), { persist: false });
  themeToggleEl.addEventListener('change', () => {
    const nextTheme = themeToggleEl.checked ? 'dark' : 'light';
    applyTheme(nextTheme, { persist: true });
  });
} else {
  const theme = getSavedTheme() || getCurrentTheme() || getSystemTheme();
  applyTheme(theme, { persist: false });
}

async function saveBuildingInfoFromModal(event) {
  event.preventDefault();
  if (!selected || !canEditBuildings) return;
  const form = event.currentTarget;
  const statusEl = document.getElementById('building-save-status');
  if (statusEl) statusEl.textContent = t('saveInProgress', null, 'Сохраняем...');

  const formData = new FormData(form);
  const yearRaw = String(formData.get('building-year') || '').trim();
  const levelsRaw = String(formData.get('building-levels') || '').trim();
  const styleSelectRaw = String(formData.get('building-style-select') || '').trim();
  const styleRaw = styleSelectRaw;

  const payload = {
    osmType: selected.osmType,
    osmId: selected.osmId,
    name: String(formData.get('building-name') || '').trim(),
    style: normalizeArchitectureStyleForSave(styleRaw),
    levels: levelsRaw,
    yearBuilt: yearRaw,
    architect: String(formData.get('building-architect') || '').trim(),
    address: buildAddressFromForm(formData),
    archimapDescription: String(formData.get('building-archimap-description') || '').trim()
  };

  const resp = await fetch('/api/building-info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    if (statusEl) statusEl.textContent = String(data?.error || t('saveFailed', null, 'Не удалось сохранить'));
    return;
  }

  const nextArchiInfo = {
    osm_type: selected.osmType,
    osm_id: selected.osmId,
    name: payload.name || null,
    style: payload.style || null,
    levels: payload.levels !== '' ? Number(payload.levels) : null,
    year_built: payload.yearBuilt ? Number(payload.yearBuilt) : null,
    architect: payload.architect || null,
    address: payload.address || null,
    archimap_description: payload.archimapDescription || null,
    updated_at: new Date().toISOString(),
    review_status: 'pending',
    admin_comment: null,
    user_edit_id: Number(data?.editId || 0) || null
  };
  applySavedInfoToFeatureCaches(selected.osmType, selected.osmId, nextArchiInfo);
  openModal(selected.feature);
  const nextStatusEl = document.getElementById('building-save-status');
  if (nextStatusEl) nextStatusEl.textContent = t('saveQueued', null, 'Отправлено на рассмотрение');
  scheduleLoadBuildings();
}

function applySavedInfoToFeature(feature, archiInfo) {
  if (!feature) return;
  feature.properties = feature.properties || {};
  feature.properties.archiInfo = archiInfo;
  feature.properties.hasExtraInfo = true;
}

function applySavedInfoToFeatureCaches(osmType, osmId, archiInfo) {
  const key = `${osmType}/${osmId}`;

  if (selected?.feature?.properties?.osm_key === key) {
    applySavedInfoToFeature(selected.feature, archiInfo);
    setSelectedFeature(selected.feature);
  }

  let touchedCurrent = false;
  for (const feature of currentBuildingsGeojson.features || []) {
    if (String(feature?.properties?.osm_key || feature?.id || '') !== key) continue;
    applySavedInfoToFeature(feature, archiInfo);
    feature.properties.has_extra_info = 1;
    feature.properties.hasExtraInfo = true;
    touchedCurrent = true;
  }

  if (touchedCurrent) {
    setLocalBuildingFeatureState(key, { hasExtraInfo: true });
  }
  localEditStateOverrides.set(key, true);
  const sourceTags = selected?.feature?.properties?.osm_key === key
    ? (getSourceTags(selected.feature) || {})
    : {};
  upsertFilterDataCacheItem({
    osmKey: key,
    sourceTags,
    archiInfo,
    hasExtraInfo: true
  });
}

modalCloseBtn.addEventListener('click', closeModal);
if (modalContentEl) {
  modalContentEl.addEventListener('click', async (event) => {
    const chipEl = event.target?.closest?.('[data-copy-chip="true"]');
    if (!chipEl) return;
    const value = String(chipEl.getAttribute('data-copy-value') || '').trim();
    if (!value) return;
    const copied = await copyTextToClipboard(value);
    if (!copied) return;
    showCopyToast(t('copied', null, 'Скопировано'));
    chipEl.classList.add('ring-2', 'ring-indigo-300', 'bg-indigo-100');
    setTimeout(() => {
      chipEl.classList.remove('ring-2', 'ring-indigo-300', 'bg-indigo-100');
    }, 500);
  });
}

if (authTabLoginEl) {
  authTabLoginEl.addEventListener('click', () => setAuthTab('login'));
}
if (authTabRegisterEl) {
  authTabRegisterEl.addEventListener('click', () => setAuthTab('register'));
}
if (forgotPasswordToggleEl) {
  forgotPasswordToggleEl.addEventListener('click', () => {
    if (!forgotPasswordPanelEl) return;
    forgotPasswordPanelEl.classList.toggle('hidden');
  });
}
if (authFabEl) {
  authFabEl.addEventListener('click', (event) => {
    if (isAuthenticated) return;
    event.preventDefault();
    openAuthModal();
  });
}
authModalCloseEl.addEventListener('click', closeAuthModal);
authModalEl.addEventListener('click', (event) => {
  if (event.target === authModalEl) closeAuthModal();
});
if (profileModalCloseEl) {
  profileModalCloseEl.addEventListener('click', closeProfileModal);
}
if (profileModalEl) {
  profileModalEl.addEventListener('click', (event) => {
    if (event.target === profileModalEl) closeProfileModal();
  });
}
if (searchModalCloseEl) {
  searchModalCloseEl.addEventListener('click', closeSearchModal);
}

function ensureMapSourcesAndLayers() {
  if (!map.getSource('local-buildings')) {
    const pmtilesUrl = PMTILES_CONFIG.url.startsWith('http')
      ? PMTILES_CONFIG.url
      : `${window.location.origin}${PMTILES_CONFIG.url.startsWith('/') ? '' : '/'}${PMTILES_CONFIG.url}`;
    map.addSource('local-buildings', {
      type: 'vector',
      url: `pmtiles://${pmtilesUrl}`
    });
  }

  if (!map.getSource('selected-building')) {
    map.addSource('selected-building', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: selected?.feature ? [selected.feature] : []
      }
    });
  }

  if (!map.getSource(SEARCH_RESULTS_SOURCE_ID)) {
    map.addSource(SEARCH_RESULTS_SOURCE_ID, {
      type: 'geojson',
      data: searchMarkersGeojson,
      cluster: true,
      clusterRadius: 48,
      clusterMaxZoom: 16
    });
  }

  if (!map.getLayer('local-buildings-fill')) {
    const style = getLocalBuildingStyleForTheme(currentMapTheme);
    map.addLayer({
      id: 'local-buildings-fill',
      type: 'fill',
      source: 'local-buildings',
      'source-layer': PMTILES_CONFIG.sourceLayer,
      minzoom: MIN_BUILDING_ZOOM,
      paint: {
        'fill-color': getBuildingFillColorExpression(),
        'fill-color-transition': {
          duration: style.transition.durationMs
        },
        'fill-opacity': getBuildingFillOpacityExpression(),
        'fill-opacity-transition': {
          duration: style.transition.durationMs
        }
      }
    });
  }

  if (!map.getLayer('local-buildings-line')) {
    const style = getLocalBuildingStyleForTheme(currentMapTheme);
    map.addLayer({
      id: 'local-buildings-line',
      type: 'line',
      source: 'local-buildings',
      'source-layer': PMTILES_CONFIG.sourceLayer,
      minzoom: MIN_BUILDING_ZOOM,
      paint: {
        'line-color': getBuildingLineColorExpression(),
        'line-color-transition': {
          duration: style.transition.durationMs
        },
        'line-width': getBuildingLineWidthExpression(),
        'line-width-transition': {
          duration: style.transition.durationMs
        },
        'line-opacity-transition': {
          duration: style.transition.durationMs
        }
      }
    });
  }

  if (!map.getLayer('selected-building-fill')) {
    map.addLayer({
      id: 'selected-building-fill',
      type: 'fill',
      source: 'selected-building',
      paint: {
        'fill-color': '#4f7db9',
        'fill-opacity': 0.55
      }
    });
  }

  if (!map.getLayer('selected-building-line')) {
    map.addLayer({
      id: 'selected-building-line',
      type: 'line',
      source: 'selected-building',
      paint: {
        'line-color': '#2b4f7b',
        'line-width': 2
      }
    });
  }

  if (!map.getLayer(SEARCH_RESULTS_CLUSTER_LAYER_ID)) {
    map.addLayer({
      id: SEARCH_RESULTS_CLUSTER_LAYER_ID,
      type: 'circle',
      source: SEARCH_RESULTS_SOURCE_ID,
      filter: ['has', 'point_count'],
      paint: {
        'circle-radius': [
          'step',
          ['get', 'point_count'],
          16,
          12, 19,
          30, 22,
          60, 26
        ],
        'circle-color': '#1d4ed8',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-opacity': 0.92
      }
    });
  }

  if (!map.getLayer(SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID)) {
    map.addLayer({
      id: SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID,
      type: 'symbol',
      source: SEARCH_RESULTS_SOURCE_ID,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['to-string', ['get', 'point_count']],
        'text-font': ['Open Sans Bold'],
        'text-size': 12
      },
      paint: {
        'text-color': '#ffffff'
      }
    });
  }

  if (!map.getLayer(SEARCH_RESULTS_LAYER_ID)) {
    map.addLayer({
      id: SEARCH_RESULTS_LAYER_ID,
      type: 'circle',
      source: SEARCH_RESULTS_SOURCE_ID,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          12, 4,
          14, 6,
          16, 7
        ],
        'circle-color': '#2563eb',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-opacity': 0.9
      }
    });
  }

  setSelectedFeature(selected?.feature || null);
  updateSearchMarkers(searchState.items);
}

function onBuildingsLayerMouseEnter() {
  map.getCanvas().style.cursor = 'pointer';
}

function setHoveredBuilding(osmKey) {
  if (hoveredBuildingKey === osmKey) return;
  if (hoveredBuildingKey) {
    setLocalBuildingFeatureState(hoveredBuildingKey, { isHovered: false });
  }
  hoveredBuildingKey = osmKey || null;
  if (hoveredBuildingKey) {
    setLocalBuildingFeatureState(hoveredBuildingKey, { isHovered: true });
  }
}

function onBuildingsLayerMouseMove(event) {
  const feature = event.features && event.features[0];
  if (!feature) {
    setHoveredBuilding(null);
    return;
  }
  normalizeFeatureInfo(feature);
  const parsed = getFeatureIdentity(feature);
  if (!parsed) {
    setHoveredBuilding(null);
    return;
  }
  setHoveredBuilding(`${parsed.osmType}/${parsed.osmId}`);
}

function onBuildingsLayerMouseLeave() {
  map.getCanvas().style.cursor = '';
  setHoveredBuilding(null);
}

function onSearchClusterClick(event) {
  const feature = event?.features?.[0];
  if (!feature) return;
  const clusterId = feature.properties?.cluster_id;
  const coordinates = feature.geometry?.coordinates;
  const source = map.getSource(SEARCH_RESULTS_SOURCE_ID);
  if (!source || clusterId == null || !Array.isArray(coordinates)) return;
  source.getClusterExpansionZoom(clusterId, (error, zoom) => {
    if (error) return;
    map.easeTo({
      center: coordinates,
      zoom: Number.isFinite(zoom) ? zoom : Math.max(map.getZoom() + 1, 14),
      duration: 350,
      essential: true
    });
  });
}

async function onBuildingsLayerClick(event) {
  const feature = event.features && event.features[0];
  if (!feature) return;
  normalizeFeatureInfo(feature);
  const parsed = getFeatureIdentity(feature);
  if (!parsed) return;

  try {
    const fullFeature = await fetchBuildingById(parsed.osmType, parsed.osmId);
    await selectBuildingFeature(fullFeature || feature);
  } catch {
    // no-op
  }
}

function bindBuildingsLayerEvents() {
  map.off('mouseenter', 'local-buildings-fill', onBuildingsLayerMouseEnter);
  map.off('mousemove', 'local-buildings-fill', onBuildingsLayerMouseMove);
  map.off('mouseleave', 'local-buildings-fill', onBuildingsLayerMouseLeave);
  map.off('click', 'local-buildings-fill', onBuildingsLayerClick);
  map.on('mouseenter', 'local-buildings-fill', onBuildingsLayerMouseEnter);
  map.on('mousemove', 'local-buildings-fill', onBuildingsLayerMouseMove);
  map.on('mouseleave', 'local-buildings-fill', onBuildingsLayerMouseLeave);
  map.on('click', 'local-buildings-fill', onBuildingsLayerClick);

  map.off('click', SEARCH_RESULTS_CLUSTER_LAYER_ID, onSearchClusterClick);
  map.on('click', SEARCH_RESULTS_CLUSTER_LAYER_ID, onSearchClusterClick);
  map.off('mouseenter', SEARCH_RESULTS_CLUSTER_LAYER_ID, onBuildingsLayerMouseEnter);
  map.on('mouseenter', SEARCH_RESULTS_CLUSTER_LAYER_ID, onBuildingsLayerMouseEnter);
  map.off('mouseleave', SEARCH_RESULTS_CLUSTER_LAYER_ID, onBuildingsLayerMouseLeave);
  map.on('mouseleave', SEARCH_RESULTS_CLUSTER_LAYER_ID, onBuildingsLayerMouseLeave);
}

map.on('style.load', () => {
  lastCartoBuildingsVisibility = null;
  hoveredBuildingKey = null;
  ensureMapSourcesAndLayers();
  bindBuildingsLayerEvents();
  updateBuildingHighlightStyle();
  updateCartoBuildingsVisibility();
  if (labelsToggleEl) {
    applyLabelsHidden(Boolean(labelsToggleEl.checked), { persist: false });
  }
});

map.on('load', async () => {
  renderBuildInfoLink();
  await loadAuthState();
  setAuthTab('login');
  if (pendingRegisterToken && !isAuthenticated) {
    openAuthModal();
    setAuthTab('register');
    if (registerVerifyStatusEl) registerVerifyStatusEl.textContent = t('authRegisterLinkConfirming', null, 'Подтверждаем регистрацию по ссылке...');
    const ok = await confirmRegistrationByToken(pendingRegisterToken);
    if (ok) {
      window.location.href = '/account/';
      return;
    }
  }
  if (!isAuthenticated && shouldOpenAuthFromUrl()) {
    openAuthModal();
  }
  if (pendingResetToken && !isAuthenticated) {
    openAuthModal();
    if (forgotPasswordPanelEl) forgotPasswordPanelEl.classList.remove('hidden');
    if (resetPasswordStatusEl) resetPasswordStatusEl.textContent = t('authResetPromptFromLink', null, 'Введите новый пароль для завершения сброса.');
  }
  await ensureDbFilterTagKeysLoaded();

  scheduleLoadBuildings();
  if (filterRowsEl && filterRowsEl.children.length === 0) {
    addFilterRow();
  }

  await syncSelectedBuildingWithUrl();
});

window.addEventListener('popstate', () => {
  syncSelectedBuildingWithUrl();
});

map.on('moveend', scheduleLoadBuildings);
map.on('zoomend', scheduleLoadBuildings);
map.on('sourcedata', (event) => {
  if (event.sourceId !== 'local-buildings') return;
  if (map.getZoom() < MIN_BUILDING_ZOOM) return;
  scheduleLoadBuildings();
});
map.on('moveend', writeViewToUrl);
map.on('zoomend', writeViewToUrl);

function isRegistrationUiEnabled() {
  return Boolean(AUTH_CONFIG.registrationEnabled || AUTH_CONFIG.bootstrapFirstAdminAvailable);
}
