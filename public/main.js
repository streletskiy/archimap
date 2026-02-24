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

function writeViewToUrl() {
  const center = map.getCenter();
  const zoom = map.getZoom();
  const nextHash = `#map=${zoom.toFixed(2)}/${center.lat.toFixed(6)}/${center.lng.toFixed(6)}`;
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

function getMapStyleForTheme(theme) {
  return theme === 'dark' ? DARK_MAP_STYLE_URL : LIGHT_MAP_STYLE_URL;
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

map.addControl(new maplibregl.NavigationControl(), 'top-right');

let selected = null;
let urlSelectionSyncSeq = 0;
let isAuthenticated = false;
let isAdmin = false;
let loadTimer = null;
let currentBuildingsGeojson = { type: 'FeatureCollection', features: [] };
let filterRowSeq = 0;
const localEditStateOverrides = new Map();
let currentVisibleBuildingKeys = new Set();

const authStatusEl = document.getElementById('auth-status');
const logoutBtn = document.getElementById('logout-btn');
const loginForm = document.getElementById('login-form');
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
const authFabLabelEl = document.getElementById('auth-fab-label');
const authIconLoginEl = document.getElementById('auth-icon-login');
const authIconUserEl = document.getElementById('auth-icon-user');
const adminEditsFabEl = document.getElementById('admin-edits-fab');
const authModalEl = document.getElementById('auth-modal');
const authModalCloseEl = document.getElementById('auth-modal-close');
const adminEditsModalEl = document.getElementById('admin-edits-modal');
const adminEditsCloseEl = document.getElementById('admin-edits-close');
const adminEditsListEl = document.getElementById('admin-edits-list');
const adminEditsStatusEl = document.getElementById('admin-edits-status');
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
const THEME_STORAGE_KEY = 'archimap-theme';
const LABELS_HIDDEN_STORAGE_KEY = 'archimap-labels-hidden';
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_RESULTS_LIMIT = 30;
const buildingSearchCache = new Map();
let activeSearchRequestToken = 0;
let searchState = {
  query: '',
  center: null,
  items: [],
  hasMore: false,
  nextCursor: null
};
let adminReassignPickState = null;

const I18N_RU = window.__ARCHIMAP_I18N_RU || {};
const UI_TEXT = Object.freeze(I18N_RU.ui || {});

function t(key, params = null, fallback = '') {
  const template = Object.prototype.hasOwnProperty.call(UI_TEXT, key) ? UI_TEXT[key] : fallback;
  const base = String(template || fallback || '');
  if (!params || typeof params !== 'object') return base;
  return base.replace(/\{(\w+)\}/g, (_, name) => (params[name] == null ? '' : String(params[name])));
}

const OSM_FILTER_TAG_LABELS_RU = Object.freeze(I18N_RU.filterTagLabels || {});

const LOCAL_EDIT_PRIORITY_TAG_KEYS = Object.freeze([
  'name',
  'architect',
  'style',
  'building:architecture',
  'levels',
  'building:levels',
  'year_built',
  'building:year',
  'address',
  'addr:full',
  'description'
]);

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
    feature.properties.archiInfo = parsed;
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
  assignIfPresent('description', info.description);
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

function getLocalEditPriorityKeys(feature) {
  const parsedInfo = safeParseJsonMaybe(feature?.properties?.archiInfo);
  const info = (parsedInfo && typeof parsedInfo === 'object') ? parsedInfo : (feature?.properties?.archiInfo || null);
  if (!info || typeof info !== 'object') return [];
  const keys = [];
  const hasText = (value) => value != null && String(value).trim() !== '';

  if (hasText(info.name)) keys.push('name');
  if (hasText(info.architect)) keys.push('architect');
  if (hasText(info.style)) keys.push('style', 'building:architecture');
  if (hasText(info.description)) keys.push('description');
  if (hasText(info.address)) keys.push('address', 'addr:full');
  if (hasText(info.levels)) keys.push('levels', 'building:levels');
  if (hasText(info.year_built)) keys.push('year_built', 'building:year');
  return keys;
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
    setLocalBuildingFeatureState(key, { isFiltered, hasExtraInfo });
    if (isFiltered) matched += 1;
  }

  for (const prevKey of currentVisibleBuildingKeys) {
    if (nextVisibleKeys.has(prevKey)) continue;
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
  const localPriorityKeys = new Set();
  for (const feature of currentBuildingsGeojson.features || []) {
    const tags = getFilterTags(feature);
    for (const key of Object.keys(tags || {})) {
      keys.add(key);
    }
    for (const key of getLocalEditPriorityKeys(feature)) {
      localPriorityKeys.add(key);
    }
  }
  for (const key of LOCAL_EDIT_PRIORITY_TAG_KEYS) {
    if (keys.has(key) && localPriorityKeys.has(key)) {
      localPriorityKeys.add(key);
    }
  }

  const sorted = [...keys].sort((a, b) => {
    const aGroup = getFilterTagGroupRank(a);
    const bGroup = getFilterTagGroupRank(b);
    if (aGroup !== bGroup) return aGroup - bGroup;
    const aLocal = localPriorityKeys.has(a) ? 0 : 1;
    const bLocal = localPriorityKeys.has(b) ? 0 : 1;
    if (aLocal !== bLocal) return aLocal - bLocal;
    const aLabel = getFilterTagDisplayName(a);
    const bLabel = getFilterTagDisplayName(b);
    return aLabel.localeCompare(bLabel, 'ru');
  });
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
}

function shouldProcessVisibleBuildings() {
  const hasActiveRules = getFilterRules().length > 0;
  const needsAdminHighlight = Boolean(isAuthenticated && isAdmin);
  const needsFilterPanelData = isFilterPanelOpen();
  return hasActiveRules || needsAdminHighlight || needsFilterPanelData;
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
  'max-h-[140px]',
  'translate-y-0',
  'scale-100',
  'opacity-100',
  'pointer-events-auto',
  'overflow-visible'
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
    sourceFeatures = map.querySourceFeatures('local-buildings', {
      sourceLayer: PMTILES_CONFIG.sourceLayer
    }) || [];
  } catch {
    sourceFeatures = [];
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

const ARCHITECTURE_STYLE_LABELS_RU = Object.freeze(I18N_RU.architectureStyleLabels || {});

const ARCHITECTURE_STYLE_ALIASES = Object.freeze(I18N_RU.architectureStyleAliases || {});

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
  isAdmin = Boolean(data?.user?.isAdmin);
  renderAuth();
}

function renderAuth() {
  if (isAuthenticated) {
    authStatusEl.textContent = t('authLoggedIn', null, 'Вы авторизованы');
    logoutBtn.classList.remove('hidden');
    loginForm.classList.add('hidden');
  } else {
    authStatusEl.textContent = t('authLoggedOut', null, 'Вход не выполнен');
    logoutBtn.classList.add('hidden');
    loginForm.classList.remove('hidden');
  }

  if (adminEditsFabEl) {
    if (isAuthenticated && isAdmin) {
      adminEditsFabEl.classList.remove('hidden');
    } else {
      adminEditsFabEl.classList.add('hidden');
      closeAdminEditsModal();
    }
  }

  if (authFabEl && authIconLoginEl && authIconUserEl) {
    if (isAuthenticated) {
      authIconLoginEl.classList.add('hidden');
      authIconUserEl.classList.remove('hidden');
      const profileText = t('authFabProfile', null, 'Профиль');
      authFabEl.setAttribute('aria-label', profileText);
      if (authFabLabelEl) authFabLabelEl.textContent = profileText;
    } else {
      authIconUserEl.classList.add('hidden');
      authIconLoginEl.classList.remove('hidden');
      const loginText = t('authFabLogin', null, 'Войти');
      authFabEl.setAttribute('aria-label', loginText);
      if (authFabLabelEl) authFabLabelEl.textContent = loginText;
    }
  }

  updateBuildingHighlightStyle();
  scheduleLoadBuildings();

  if (selected && !modalEl.classList.contains('hidden')) {
    openModal(selected.feature);
  }
}

function getBuildingFillColorExpression() {
  return [
    'case',
    ['all', ['boolean', ['feature-state', 'hasExtraInfo'], false], ['literal', Boolean(isAuthenticated && isAdmin)]],
    '#f59e0b',
    ['boolean', ['feature-state', 'isFiltered'], false],
    '#12b4a6',
    '#d3d3d3'
  ];
}

function getBuildingFillOpacityExpression() {
  return [
    'case',
    ['all', ['boolean', ['feature-state', 'hasExtraInfo'], false], ['literal', Boolean(isAuthenticated && isAdmin)]],
    0.82,
    ['boolean', ['feature-state', 'isFiltered'], false],
    0.82,
    0.24
  ];
}

function getBuildingLineColorExpression() {
  return [
    'case',
    ['all', ['boolean', ['feature-state', 'hasExtraInfo'], false], ['literal', Boolean(isAuthenticated && isAdmin)]],
    '#b45309',
    ['boolean', ['feature-state', 'isFiltered'], false],
    '#0b6d67',
    '#8c8c8c'
  ];
}

function getBuildingLineWidthExpression() {
  return [
    'case',
    ['all', ['boolean', ['feature-state', 'hasExtraInfo'], false], ['literal', Boolean(isAuthenticated && isAdmin)]],
    1.8,
    ['boolean', ['feature-state', 'isFiltered'], false],
    1.4,
    1
  ];
}

function updateBuildingHighlightStyle() {
  if (!map.getLayer('local-buildings-fill') || !map.getLayer('local-buildings-line')) return;
  map.setPaintProperty('local-buildings-fill', 'fill-color', getBuildingFillColorExpression());
  map.setPaintProperty('local-buildings-fill', 'fill-opacity', getBuildingFillOpacityExpression());
  map.setPaintProperty('local-buildings-line', 'line-color', getBuildingLineColorExpression());
  map.setPaintProperty('local-buildings-line', 'line-width', getBuildingLineWidthExpression());
}

function buildEditField(label, id, type, value, placeholder) {
  return `
    <label class="block">
      <span class="mb-1 block text-sm font-semibold text-slate-800">${label}</span>
      <input id="${id}" name="${id}" type="${type}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder || '')}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
    </label>
  `;
}

function buildEditTextarea(label, id, value, placeholder) {
  return `
    <label class="block">
      <span class="mb-1 block text-sm font-semibold text-slate-800">${label}</span>
      <textarea id="${id}" name="${id}" rows="3" placeholder="${escapeHtml(placeholder || '')}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200">${escapeHtml(value || '')}</textarea>
    </label>
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
  const osmName = osmNameFromTags(osmTags);
  const osmLevels = osmLevelsFromTags(osmTags);

  const shownName = info.name || osmName || '-';
  const shownAddress = info.address || osmAddress || '-';
  const shownLevels = info.levels ?? osmLevels ?? '-';
  const shownYear = info.year_built || osmYear || '-';
  const shownArchitect = info.architect || osmArchitect || '-';
  const shownStyleRaw = info.style || osmStyle || '-';
  const shownStyle = shownStyleRaw === '-' ? '-' : (toHumanArchitectureStyle(shownStyleRaw) || shownStyleRaw);
  const styleOptions = getArchitectureStyleOptions();
  const styleEditState = getArchitectureStyleEditState(info.style || osmStyle || '');
  const styleOptionsHtml = styleOptions
    .map((option) => `<option value="${escapeHtml(option.key)}" ${styleEditState.selectedKey === option.key ? 'selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('');
  const editableRows = isAuthenticated
    ? `
      <form id="building-edit-form" class="grid gap-2.5">
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <label for="building-name" class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalLabelName', null, 'Название:'))}</label>
          <input id="building-name" name="building-name" type="text" value="${escapeHtml(info.name || (shownName !== '-' ? shownName : ''))}" class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <label for="building-levels" class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalLabelLevels', null, 'Этажей:'))}</label>
          <input id="building-levels" name="building-levels" type="number" value="${escapeHtml(info.levels ?? (shownLevels !== '-' ? shownLevels : ''))}" class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <label for="building-year" class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalLabelYearBuilt', null, 'Год постройки:'))}</label>
          <input id="building-year" name="building-year" type="number" value="${escapeHtml(info.year_built || (shownYear !== '-' ? shownYear : ''))}" class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <label for="building-architect" class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalLabelArchitect', null, 'Архитектор:'))}</label>
          <input id="building-architect" name="building-architect" type="text" value="${escapeHtml(info.architect || (shownArchitect !== '-' ? shownArchitect : ''))}" class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <label for="building-style-select" class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalLabelStyle', null, 'Архитектурный стиль:'))}</label>
          <select id="building-style-select" name="building-style-select" class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200">
            <option value="" ${styleEditState.selectedKey === '' ? 'selected' : ''}>${escapeHtml(t('modalStyleNotSet', null, 'Не указан'))}</option>
            ${styleOptionsHtml}
          </select>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <label for="building-description" class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalLabelDescription', null, 'Описание:'))}</label>
          <textarea id="building-description" name="building-description" rows="3" class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200">${escapeHtml(info.description || '')}</textarea>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <div class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalAddressTagsTitle', null, 'Адрес (OSM теги):'))}</div>
          <div class="mt-2 grid gap-2 md:grid-cols-2">
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
        <div class="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-3">
          <p id="building-save-status" class="text-sm text-slate-600"></p>
          <button type="submit" class="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700">${escapeHtml(t('modalSave', null, 'Сохранить'))}</button>
        </div>
      </form>
    `
    : `
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalLabelName', null, 'Название:'))}</b>${escapeHtml(shownName)}</div>
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalLabelAddress', null, 'Адрес:'))}</b>${escapeHtml(shownAddress)}</div>
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalLabelLevels', null, 'Этажей:'))}</b>${escapeHtml(shownLevels)}</div>
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalLabelYearBuilt', null, 'Год постройки:'))}</b>${escapeHtml(shownYear)}</div>
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalLabelArchitect', null, 'Архитектор:'))}</b>${escapeHtml(shownArchitect)}</div>
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalLabelStyle', null, 'Архитектурный стиль:'))}</b>${escapeHtml(shownStyle)}</div>
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">${escapeHtml(t('modalLabelDescription', null, 'Описание:'))}</b>${escapeHtml(info.description || '-')}</div>
      <div class="rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm text-slate-700">
        ${escapeHtml(t('modalLoginHint', null, 'Для редактирования войдите через кнопку в левом нижнем углу.'))}
      </div>
    `;

  return `
    <div class="grid gap-2.5">
      ${editableRows}
      <details class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft">
        <summary class="relative cursor-pointer list-none bg-slate-50 px-3.5 py-3 pr-10 font-bold text-slate-900 transition hover:bg-slate-100 after:absolute after:right-3 after:top-1/2 after:-translate-y-1/2 after:content-['▾'] [&::-webkit-details-marker]:hidden [&[open]_summary]:after:rotate-180">${escapeHtml(t('modalOsmTagsSummary', null, 'OSM теги'))}</summary>
        <pre class="m-0 border-t border-slate-200 bg-white px-3.5 py-3 text-xs leading-6 text-slate-700 whitespace-pre-wrap break-words">${escapeHtml(JSON.stringify({
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

function openAuthModal() {
  authModalEl.classList.remove('hidden');
  authModalEl.setAttribute('aria-hidden', 'false');
}

function closeAuthModal() {
  authModalEl.classList.add('hidden');
  authModalEl.setAttribute('aria-hidden', 'true');
}

function openSearchModal(prefill = '') {
  if (!searchModalEl) return;
  searchModalEl.classList.remove('hidden');
  searchModalEl.setAttribute('aria-hidden', 'false');
  if (searchModalInputEl) {
    searchModalInputEl.value = String(prefill || '').trim();
    setTimeout(() => searchModalInputEl.focus(), 0);
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
      <div class="animate-pulse rounded-xl border border-slate-200 bg-slate-50 p-3">
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
      <article class="rounded-xl border border-slate-200 bg-slate-50 p-3">
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
}

async function runBuildingSearch(query, options = {}) {
  const { append = false } = options;
  const text = String(query || '').trim().slice(0, 120);
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
  if (!append) {
    searchState = {
      query: text,
      center,
      items: [],
      hasMore: false,
      nextCursor: null
    };
  }

  const cacheKey = buildSearchCacheKey(text, center, cursor);
  const cached = getSearchCache(cacheKey);
  if (cached) {
    const cachedItems = Array.isArray(cached.items) ? cached.items : [];
    if (append) {
      searchState.items = searchState.items.concat(cachedItems);
    } else {
      searchState.items = cachedItems;
    }
    searchState.hasMore = Boolean(cached.hasMore);
    searchState.nextCursor = Number.isFinite(cached.nextCursor) ? Number(cached.nextCursor) : null;
    renderSearchResults(searchState.items, { hasMore: searchState.hasMore });
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
    q: text,
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
        if (searchLoadMoreBtnEl) searchLoadMoreBtnEl.classList.add('hidden');
      }
      return;
    }

    const data = await resp.json().catch(() => ({ items: [], hasMore: false, nextCursor: null }));
    const items = Array.isArray(data.items) ? data.items : [];
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

function renderAdminEdits(items) {
  if (!adminEditsListEl) return;
  adminEditsListEl.innerHTML = items.map((item) => {
    const sourceKey = `${item.osmType}/${item.osmId}`;
    const changesHtml = item.changes.map((change) => `
      <div class="rounded-lg border border-slate-200 bg-white p-2.5">
        <div class="mb-1 flex items-center justify-between gap-2">
          <div class="text-xs font-semibold text-slate-600">${escapeHtml(change.label)}</div>
          <div class="text-[11px] font-semibold ${change.isLocalTag ? 'text-rose-600' : 'text-slate-500'}">
            ${change.isLocalTag ? escapeHtml(t('adminLocalTag', null, 'Локальный тег')) : `OSM: ${escapeHtml(change.osmTag || '—')}`}
          </div>
        </div>
        <div class="grid gap-1 md:grid-cols-2 md:gap-2">
          <div class="rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-700"><span class="font-semibold text-slate-500">OSM:</span> ${escapeHtml(formatChangeValue(change.osmValue))}</div>
          <div class="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900"><span class="font-semibold text-amber-700">${escapeHtml(t('adminChangedTo', null, 'Стало:'))}</span> ${escapeHtml(formatChangeValue(change.localValue))}</div>
        </div>
      </div>
    `).join('');

    const orphanControlsHtml = item.orphaned
      ? `
        <div class="mb-2 rounded-lg border border-rose-200 bg-rose-50 p-2.5">
          <div class="mb-2 text-xs font-semibold text-rose-700">${escapeHtml(t('adminOrphanHint', null, 'Здание удалено из OSM. Можно удалить локальные правки или переназначить их на другое здание.'))}</div>
          <div class="grid gap-2 sm:grid-cols-[1fr_auto]">
            <input data-field="target-osm-key" data-source-key="${escapeHtml(sourceKey)}" type="text" placeholder="${escapeHtml(t('adminOrphanTargetPlaceholder', null, 'way/123456 или relation/123456'))}" class="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
            <button data-action="admin-reassign-submit" data-osm-type="${escapeHtml(item.osmType)}" data-osm-id="${escapeHtml(item.osmId)}" type="button" class="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">${escapeHtml(t('adminReassign', null, 'Переназначить'))}</button>
          </div>
          <div class="mt-2 flex items-center gap-2">
            <button data-action="admin-reassign-pick" data-osm-type="${escapeHtml(item.osmType)}" data-osm-id="${escapeHtml(item.osmId)}" type="button" class="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">${escapeHtml(t('adminReassignByMap', null, 'Выбрать на карте'))}</button>
            <button data-action="admin-delete-orphan" data-osm-type="${escapeHtml(item.osmType)}" data-osm-id="${escapeHtml(item.osmId)}" type="button" class="rounded-md border border-rose-300 bg-white px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50">${escapeHtml(t('adminDeleteOrphan', null, 'Удалить правки'))}</button>
          </div>
        </div>
      `
      : '';

    return `
      <article class="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div class="mb-2 flex items-start justify-between gap-2">
          <div class="text-sm font-semibold text-slate-900">${escapeHtml(sourceKey)} ${item.orphaned ? `<span class="ml-1 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">${escapeHtml(t('adminOrphanBadge', null, 'удалено из OSM'))}</span>` : ''}</div>
          <a class="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100" href="?b=${encodeURIComponent(`${item.osmType}/${item.osmId}`)}${window.location.hash || ''}">${escapeHtml(t('adminOpen', null, 'Открыть'))}</a>
        </div>
        <div class="mb-2 text-xs text-slate-600">${escapeHtml(t('adminChangedBy', null, 'Изменил:'))} <b class="text-slate-900">${escapeHtml(item.updatedBy || '—')}</b> • ${escapeHtml(formatUpdatedAt(item.updatedAt))}</div>
        ${orphanControlsHtml}
        <div class="space-y-2">${changesHtml}</div>
      </article>
    `;
  }).join('');
}

async function deleteOrphanLocalEdit(osmType, osmId) {
  const osmKey = `${osmType}/${osmId}`;
  const confirmed = window.confirm(t('adminDeleteConfirm', { osmKey }, `Удалить локальные правки для ${osmKey}?`));
  if (!confirmed) return;
  const resp = await fetch('/api/admin/building-edits/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ osmType, osmId })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: t('adminDeleteFailed', null, 'Не удалось удалить правки') }));
    if (adminEditsStatusEl) adminEditsStatusEl.textContent = err.error || t('adminDeleteFailed', null, 'Не удалось удалить правки');
    return;
  }
  if (adminEditsStatusEl) adminEditsStatusEl.textContent = t('adminDeleteDone', { osmKey }, `Локальные правки ${osmKey} удалены`);
  await loadAdminEdits();
}

async function reassignLocalEdit(fromOsmType, fromOsmId, toOsmType, toOsmId) {
  const resp = await fetch('/api/admin/building-edits/reassign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromOsmType, fromOsmId, toOsmType, toOsmId })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: t('adminReassignFailed', null, 'Не удалось переназначить правки') }));
    if (adminEditsStatusEl) adminEditsStatusEl.textContent = err.error || t('adminReassignFailed', null, 'Не удалось переназначить правки');
    return false;
  }
  if (adminEditsStatusEl) adminEditsStatusEl.textContent = t(
    'adminReassignDone',
    { from: `${fromOsmType}/${fromOsmId}`, to: `${toOsmType}/${toOsmId}` },
    `Правки переназначены: ${fromOsmType}/${fromOsmId} -> ${toOsmType}/${toOsmId}`
  );
  await loadAdminEdits();
  return true;
}

async function loadAdminEdits() {
  if (!adminEditsStatusEl || !adminEditsListEl) return;
  adminEditsStatusEl.textContent = t('adminLoading', null, 'Загрузка...');
  adminEditsListEl.innerHTML = '';

  const resp = await fetch('/api/admin/building-edits');
  if (!resp.ok) {
    adminEditsStatusEl.textContent = t('adminLoadFailed', null, 'Не удалось загрузить список правок.');
    return;
  }

  const data = await resp.json().catch(() => ({ total: 0, items: [] }));
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) {
    adminEditsStatusEl.textContent = t('adminNoEdits', null, 'Локальные правки не найдены.');
    return;
  }

  adminEditsStatusEl.textContent = t('adminFoundEdits', { count: items.length }, `Найдено правок: ${items.length}`);
  renderAdminEdits(items);
}

function openAdminEditsModal() {
  if (!isAuthenticated || !isAdmin || !adminEditsModalEl) return;
  adminEditsModalEl.classList.remove('hidden');
  adminEditsModalEl.setAttribute('aria-hidden', 'false');
  loadAdminEdits();
}

function closeAdminEditsModal() {
  if (!adminEditsModalEl) return;
  adminEditsModalEl.classList.add('hidden');
  adminEditsModalEl.setAttribute('aria-hidden', 'true');
}

function setSelectedFeature(feature) {
  const source = map.getSource('selected-building');
  if (!source) return;
  source.setData({
    type: 'FeatureCollection',
    features: feature ? [feature] : []
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
  if (!map.getSource('local-buildings')) return;

  if (map.getZoom() < MIN_BUILDING_ZOOM) {
    currentBuildingsGeojson = { type: 'FeatureCollection', features: [] };
    for (const key of currentVisibleBuildingKeys) {
      setLocalBuildingFeatureState(key, { isFiltered: false });
    }
    currentVisibleBuildingKeys = new Set();
    refreshTagKeysDatalist();
    applyFiltersToCurrentData();
    return;
  }

  if (!shouldProcessVisibleBuildings()) {
    currentBuildingsGeojson = { type: 'FeatureCollection', features: [] };
    for (const key of currentVisibleBuildingKeys) {
      setLocalBuildingFeatureState(key, { isFiltered: false, hasExtraInfo: false });
    }
    currentVisibleBuildingKeys = new Set();
    if (filterStatusEl) {
      filterStatusEl.textContent = t('filterInactive', null, 'Фильтр не активен.');
    }
    return;
  }

  currentBuildingsGeojson = {
    type: 'FeatureCollection',
    features: getVisibleBuildingsSnapshot()
  };
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

  const resp = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  if (!resp.ok) {
    authStatusEl.textContent = t('authError', null, 'Ошибка авторизации');
    return;
  }

  const data = await resp.json().catch(() => ({ user: null }));
  isAuthenticated = true;
  isAdmin = Boolean(data?.user?.isAdmin);
  renderAuth();
  closeAuthModal();
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  isAuthenticated = false;
  isAdmin = false;
  renderAuth();
});

if (searchFormEl) {
  searchFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = String(searchInputEl?.value || '').trim().slice(0, 120);
    openSearchModal(text);
    if (searchModalInputEl) searchModalInputEl.value = text;
    await runBuildingSearch(text, { append: false });
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

if (adminEditsListEl) {
  adminEditsListEl.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('button[data-action]');
    if (!button) return;
    const action = String(button.getAttribute('data-action') || '').trim();
    const osmType = String(button.getAttribute('data-osm-type') || '').trim();
    const osmId = Number(button.getAttribute('data-osm-id'));
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) return;

    if (action === 'admin-delete-orphan') {
      button.disabled = true;
      try {
        await deleteOrphanLocalEdit(osmType, osmId);
      } finally {
        button.disabled = false;
      }
      return;
    }

    if (action === 'admin-reassign-submit') {
      const sourceKey = `${osmType}/${osmId}`;
      const input = adminEditsListEl.querySelector(`input[data-field="target-osm-key"][data-source-key="${sourceKey}"]`);
      const raw = String(input?.value || '').trim();
      const parsed = parseKey(raw);
      if (!parsed) {
        if (adminEditsStatusEl) adminEditsStatusEl.textContent = t('adminReassignInvalidTarget', null, 'Укажите корректный OSM ключ в формате way/123 или relation/123');
        return;
      }
      button.disabled = true;
      try {
        await reassignLocalEdit(osmType, osmId, parsed.osmType, parsed.osmId);
      } finally {
        button.disabled = false;
      }
      return;
    }

    if (action === 'admin-reassign-pick') {
      adminReassignPickState = { fromOsmType: osmType, fromOsmId: osmId };
      closeAdminEditsModal();
      if (adminEditsStatusEl) adminEditsStatusEl.textContent = '';
      window.alert(t('adminReassignPickHint', { osmKey: `${osmType}/${osmId}` }, `Выберите на карте целевое здание для переназначения правок ${osmType}/${osmId}.`));
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
  if (!selected || !isAuthenticated) return;
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
    description: String(formData.get('building-description') || '').trim()
  };

  const resp = await fetch('/api/building-info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: t('saveFailed', null, 'Не удалось сохранить') }));
    if (statusEl) statusEl.textContent = err.error || t('saveFailed', null, 'Не удалось сохранить');
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
    description: payload.description || null,
    updated_at: new Date().toISOString()
  };
  applySavedInfoToFeatureCaches(selected.osmType, selected.osmId, nextArchiInfo);
  openModal(selected.feature);
  const nextStatusEl = document.getElementById('building-save-status');
  if (nextStatusEl) nextStatusEl.textContent = t('saveDone', null, 'Сохранено');
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
}

modalCloseBtn.addEventListener('click', closeModal);
authFabEl.addEventListener('click', openAuthModal);
if (adminEditsFabEl) {
  adminEditsFabEl.addEventListener('click', openAdminEditsModal);
}
authModalCloseEl.addEventListener('click', closeAuthModal);
authModalEl.addEventListener('click', (event) => {
  if (event.target === authModalEl) closeAuthModal();
});
if (searchModalCloseEl) {
  searchModalCloseEl.addEventListener('click', closeSearchModal);
}
if (searchModalEl) {
  searchModalEl.addEventListener('click', (event) => {
    if (event.target === searchModalEl) closeSearchModal();
  });
}
if (adminEditsCloseEl) {
  adminEditsCloseEl.addEventListener('click', closeAdminEditsModal);
}
if (adminEditsModalEl) {
  adminEditsModalEl.addEventListener('click', (event) => {
    if (event.target === adminEditsModalEl) closeAdminEditsModal();
  });
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

  if (!map.getLayer('local-buildings-fill')) {
    map.addLayer({
      id: 'local-buildings-fill',
      type: 'fill',
      source: 'local-buildings',
      'source-layer': PMTILES_CONFIG.sourceLayer,
      minzoom: MIN_BUILDING_ZOOM,
      paint: {
        'fill-color': getBuildingFillColorExpression(),
        'fill-opacity': getBuildingFillOpacityExpression(),
        'fill-opacity-transition': {
          duration: 220
        }
      }
    });
  }

  if (!map.getLayer('local-buildings-line')) {
    map.addLayer({
      id: 'local-buildings-line',
      type: 'line',
      source: 'local-buildings',
      'source-layer': PMTILES_CONFIG.sourceLayer,
      minzoom: MIN_BUILDING_ZOOM,
      paint: {
        'line-color': getBuildingLineColorExpression(),
        'line-width': getBuildingLineWidthExpression(),
        'line-opacity-transition': {
          duration: 220
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

  setSelectedFeature(selected?.feature || null);
}

function onBuildingsLayerMouseEnter() {
  map.getCanvas().style.cursor = 'pointer';
}

function onBuildingsLayerMouseLeave() {
  map.getCanvas().style.cursor = '';
}

async function onBuildingsLayerClick(event) {
  const feature = event.features && event.features[0];
  if (!feature) return;
  normalizeFeatureInfo(feature);
  const parsed = getFeatureIdentity(feature);
  if (!parsed) return;

  if (adminReassignPickState && isAuthenticated && isAdmin) {
    const { fromOsmType, fromOsmId } = adminReassignPickState;
    adminReassignPickState = null;
    await reassignLocalEdit(fromOsmType, fromOsmId, parsed.osmType, parsed.osmId);
    openAdminEditsModal();
    return;
  }

  try {
    const fullFeature = await fetchBuildingById(parsed.osmType, parsed.osmId);
    await selectBuildingFeature(fullFeature || feature);
  } catch {
    // no-op
  }
}

function bindBuildingsLayerEvents() {
  map.off('mouseenter', 'local-buildings-fill', onBuildingsLayerMouseEnter);
  map.off('mouseleave', 'local-buildings-fill', onBuildingsLayerMouseLeave);
  map.off('click', 'local-buildings-fill', onBuildingsLayerClick);
  map.on('mouseenter', 'local-buildings-fill', onBuildingsLayerMouseEnter);
  map.on('mouseleave', 'local-buildings-fill', onBuildingsLayerMouseLeave);
  map.on('click', 'local-buildings-fill', onBuildingsLayerClick);
}

map.on('style.load', () => {
  ensureMapSourcesAndLayers();
  bindBuildingsLayerEvents();
  updateBuildingHighlightStyle();
  if (labelsToggleEl) {
    applyLabelsHidden(Boolean(labelsToggleEl.checked), { persist: false });
  }
});

map.on('load', async () => {
  await loadAuthState();

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
