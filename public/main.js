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

function writeBuildingToUrl(osmType, osmId) {
  const url = new URL(window.location.href);
  url.searchParams.set('b', `${osmType}/${osmId}`);
  history.replaceState(null, '', url.toString());
}

function clearBuildingFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete('b');
  history.replaceState(null, '', url.toString());
}

const initialView = readViewFromUrl();
const LIGHT_MAP_STYLE_URL = '/styles/positron-custom.json';
const DARK_MAP_STYLE_URL = '/styles/dark-matter-custom.json';
let currentMapTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

function getMapStyleForTheme(theme) {
  return theme === 'dark' ? DARK_MAP_STYLE_URL : LIGHT_MAP_STYLE_URL;
}

const map = new maplibregl.Map({
  container: 'map',
  style: getMapStyleForTheme(currentMapTheme),
  center: initialView ? initialView.center : [44.0059, 56.3269],
  zoom: initialView ? initialView.zoom : 15,
  attributionControl: true
});

const MIN_BUILDING_ZOOM = 13;
const TILE_FETCH_ZOOM_MAX = 16;
const TILE_CACHE_LIMIT = 320;

map.addControl(new maplibregl.NavigationControl(), 'top-right');

let selected = null;
let isAuthenticated = false;
let isAdmin = false;
let loadTimer = null;
let loadRequestSeq = 0;
let currentBuildingsGeojson = { type: 'FeatureCollection', features: [] };
let filterRowSeq = 0;
const tileCache = new Map();
let visibleTileKeys = new Set();

const authStatusEl = document.getElementById('auth-status');
const logoutBtn = document.getElementById('logout-btn');
const loginForm = document.getElementById('login-form');
const filterToggleBtnEl = document.getElementById('filter-toggle-btn');
const filterShellEl = document.getElementById('filter-shell');
const filterCompactEl = document.getElementById('filter-compact');
const filterPanelEl = document.getElementById('filter-panel');
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
const authIconLoginEl = document.getElementById('auth-icon-login');
const authIconUserEl = document.getElementById('auth-icon-user');
const adminEditsFabEl = document.getElementById('admin-edits-fab');
const authModalEl = document.getElementById('auth-modal');
const authModalCloseEl = document.getElementById('auth-modal-close');
const adminEditsModalEl = document.getElementById('admin-edits-modal');
const adminEditsCloseEl = document.getElementById('admin-edits-close');
const adminEditsListEl = document.getElementById('admin-edits-list');
const adminEditsStatusEl = document.getElementById('admin-edits-status');
const THEME_STORAGE_KEY = 'archimap-theme';

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

function applyTheme(theme, options = {}) {
  const { persist = true } = options;
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', normalized);
  applyMapTheme(normalized);

  if (themeToggleEl) {
    themeToggleEl.checked = normalized === 'dark';
    themeToggleEl.setAttribute(
      'aria-label',
      normalized === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'
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
  delete props.archiInfo;
  delete props.hasExtraInfo;
  delete props.source_tags;
  return props;
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

function applyFiltersToCurrentData() {
  if (!currentBuildingsGeojson || !Array.isArray(currentBuildingsGeojson.features)) return;
  const rules = getFilterRules();
  const source = map.getSource('local-buildings');
  let matched = 0;

  for (const feature of currentBuildingsGeojson.features) {
    const tags = getSourceTags(feature);
    const isFiltered = rules.length > 0 && rules.every((rule) => matchesRule(tags, rule));
    feature.properties = feature.properties || {};
    feature.properties.isFiltered = isFiltered;
    if (isFiltered) matched += 1;
  }

  if (source) source.setData(currentBuildingsGeojson);

  if (!filterStatusEl) return;
  const total = currentBuildingsGeojson.features.length;
  if (rules.length === 0) {
    filterStatusEl.textContent = 'Фильтр не активен.';
  } else {
    filterStatusEl.textContent = `Подсвечено ${matched} из ${total} зданий в текущем окне карты.`;
  }
}

function refreshTagKeysDatalist() {
  if (!filterTagKeysEl) return;
  const keys = new Set();
  for (const feature of currentBuildingsGeojson.features || []) {
    const tags = getSourceTags(feature);
    for (const key of Object.keys(tags || {})) {
      keys.add(key);
    }
  }
  const sorted = [...keys].sort((a, b) => a.localeCompare(b, 'ru'));
  filterTagKeysEl.innerHTML = sorted.map((k) => `<option value="${escapeHtml(k)}"></option>`).join('');
}

function buildFilterRow() {
  const row = document.createElement('div');
  row.dataset.filterRow = String(++filterRowSeq);
  row.className = 'grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5';
  row.innerHTML = `
    <input data-field="key" list="filter-tag-keys" placeholder="Тег, например building:levels" class="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
    <select data-field="op" class="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200">
      <option value="contains">содержит</option>
      <option value="equals">равно</option>
      <option value="not_equals">не равно</option>
      <option value="starts_with">начинается с</option>
      <option value="exists">существует</option>
      <option value="not_exists">отсутствует</option>
    </select>
    <input data-field="value" placeholder="Значение" class="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
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

function openFilterPanel() {
  if (!filterPanelEl || !filterShellEl || !filterCompactEl) return;
  filterCompactEl.classList.add('hidden');
  filterPanelEl.classList.remove('hidden');
  filterShellEl.classList.remove('w-[240px]', 'p-2');
  filterShellEl.classList.add('w-[360px]', 'max-h-[70vh]', 'overflow-auto', 'p-3');
}

function closeFilterPanel() {
  if (!filterPanelEl || !filterShellEl || !filterCompactEl) return;
  filterPanelEl.classList.add('hidden');
  filterCompactEl.classList.remove('hidden');
  filterShellEl.classList.remove('w-[360px]', 'max-h-[70vh]', 'overflow-auto', 'p-3');
  filterShellEl.classList.add('w-[240px]', 'p-2');
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

function clampTileX(x, z) {
  const n = 2 ** z;
  return ((x % n) + n) % n;
}

function clampTileY(y, z) {
  const n = 2 ** z;
  return Math.max(0, Math.min(n - 1, y));
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x: clampTileX(x, z), y: clampTileY(y, z) };
}

function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

function touchTileCacheEntry(key, value) {
  if (tileCache.has(key)) tileCache.delete(key);
  tileCache.set(key, value);
}

function pruneTileCache() {
  while (tileCache.size > TILE_CACHE_LIMIT) {
    const firstKey = tileCache.keys().next().value;
    if (firstKey == null) break;
    tileCache.delete(firstKey);
  }
}

function getVisibleTileKeys() {
  const bounds = map.getBounds();
  const z = Math.min(TILE_FETCH_ZOOM_MAX, Math.max(MIN_BUILDING_ZOOM, Math.floor(map.getZoom())));

  const nw = lonLatToTile(bounds.getWest(), bounds.getNorth(), z);
  const se = lonLatToTile(bounds.getEast(), bounds.getSouth(), z);

  const minX = Math.min(nw.x, se.x);
  const maxX = Math.max(nw.x, se.x);
  const minY = Math.min(nw.y, se.y);
  const maxY = Math.max(nw.y, se.y);

  const keys = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      keys.push(tileKey(z, x, y));
    }
  }
  return keys;
}

function rebuildCurrentBuildingsFromVisibleTiles() {
  const seen = new Set();
  const features = [];

  for (const key of visibleTileKeys) {
    const entry = tileCache.get(key);
    const tileFeatures = entry?.geojson?.features || [];
    for (const feature of tileFeatures) {
      const id = String(feature?.id || feature?.properties?.osm_key || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      features.push(feature);
    }
  }

  currentBuildingsGeojson = {
    type: 'FeatureCollection',
    features
  };
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

const ARCHITECTURE_STYLE_LABELS_RU = Object.freeze({
  islamic: 'Исламская архитектура',
  mamluk: 'Мамлюкская архитектура',
  romanesque: 'Романская архитектура',
  gothic: 'Готическая архитектура',
  renaissance: 'Архитектура Возрождения',
  mannerism: 'Маньеризм',
  ottoman: 'Османская архитектура',
  baroque: 'Архитектура барокко',
  rococo: 'Рококо',
  neoclassicism: 'Классицизм',
  empire: 'Ампир',
  moorish_revival: 'Неомавританский стиль',
  'pseudo-russian': 'Псевдорусский стиль',
  eclectic: 'Эклектика',
  georgian: 'Георгианская архитектура',
  victorian: 'Викторианская архитектура',
  historicism: 'Историцизм',
  'neo-romanesque': 'Неороманский стиль',
  'neo-gothic': 'Неоготика',
  'pseudo-gothic': 'Русская псевдоготика',
  russian_gothic: 'Русская псевдоготика',
  'neo-byzantine': 'Неовизантийский стиль',
  'neo-renaissance': 'Неоренессанс',
  'neo-baroque': 'Необарокко',
  art_nouveau: 'Архитектура модерна',
  nothern_modern: 'Северный модерн',
  functionalism: 'Функционализм',
  cubism: 'Кубизм',
  new_objectivity: 'Новая вещественность',
  art_deco: 'Ар-деко',
  modern: 'Архитектурный модернизм',
  amsterdam_school: 'Амстердамская школа',
  international_style: 'Интернациональный стиль',
  constructivism: 'Конструктивизм',
  postconstructivism: 'Постконструктивизм',
  stalinist_neoclassicism: 'Сталинский ампир',
  brutalist: 'Брутализм',
  postmodern: 'Архитектура постмодернизма',
  contemporary: 'Современная архитектура',
  vernacular: 'Народная архитектура',
  classic_swahili: 'Классический суахили',
  omani: 'Оманская архитектура (Занзибар)',
  indian: 'Индийское влияние (Занзибар)',
  british_colonial: 'Британская колониальная архитектура',
  modernism: 'Модернизм',
  hypermodern: 'Гипермодернизм'
});

const ARCHITECTURE_STYLE_ALIASES = Object.freeze({
  brutalism: 'brutalist',
  'stalinist neoclassicism': 'stalinist_neoclassicism'
});

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
    authStatusEl.textContent = 'Вы авторизованы';
    logoutBtn.classList.remove('hidden');
    loginForm.classList.add('hidden');
  } else {
    authStatusEl.textContent = 'Вход не выполнен';
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
      authFabEl.setAttribute('aria-label', 'Профиль');
    } else {
      authIconUserEl.classList.add('hidden');
      authIconLoginEl.classList.remove('hidden');
      authFabEl.setAttribute('aria-label', 'Вход');
    }
  }

  updateBuildingHighlightStyle();

  if (selected && !modalEl.classList.contains('hidden')) {
    openModal(selected.feature);
  }
}

function getBuildingFillColorExpression() {
  return [
    'case',
    ['all', ['boolean', ['get', 'hasExtraInfo'], false], ['literal', Boolean(isAuthenticated && isAdmin)]],
    '#f59e0b',
    ['boolean', ['get', 'isFiltered'], false],
    '#12b4a6',
    '#d3d3d3'
  ];
}

function getBuildingFillOpacityExpression() {
  return [
    'case',
    ['all', ['boolean', ['get', 'hasExtraInfo'], false], ['literal', Boolean(isAuthenticated && isAdmin)]],
    0.82,
    ['boolean', ['get', 'isFiltered'], false],
    0.82,
    0.24
  ];
}

function getBuildingLineColorExpression() {
  return [
    'case',
    ['all', ['boolean', ['get', 'hasExtraInfo'], false], ['literal', Boolean(isAuthenticated && isAdmin)]],
    '#b45309',
    ['boolean', ['get', 'isFiltered'], false],
    '#0b6d67',
    '#8c8c8c'
  ];
}

function getBuildingLineWidthExpression() {
  return [
    'case',
    ['all', ['boolean', ['get', 'hasExtraInfo'], false], ['literal', Boolean(isAuthenticated && isAdmin)]],
    1.8,
    ['boolean', ['get', 'isFiltered'], false],
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
  const editableRows = isAuthenticated
    ? `
      <form id="building-edit-form" class="grid gap-2.5">
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <label for="building-name" class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Название:</label>
          <input id="building-name" name="building-name" type="text" value="${escapeHtml(info.name || (shownName !== '-' ? shownName : ''))}" class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <label for="building-address" class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Адрес:</label>
          <input id="building-address" name="building-address" type="text" value="${escapeHtml(info.address || (shownAddress !== '-' ? shownAddress : ''))}" class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <label for="building-levels" class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Этажей:</label>
          <input id="building-levels" name="building-levels" type="number" value="${escapeHtml(info.levels ?? (shownLevels !== '-' ? shownLevels : ''))}" class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <label for="building-year" class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Год постройки:</label>
          <input id="building-year" name="building-year" type="number" value="${escapeHtml(info.year_built || (shownYear !== '-' ? shownYear : ''))}" class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <label for="building-architect" class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Архитектор:</label>
          <input id="building-architect" name="building-architect" type="text" value="${escapeHtml(info.architect || (shownArchitect !== '-' ? shownArchitect : ''))}" class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <label for="building-style" class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Архитектурный стиль:</label>
          <input id="building-style" name="building-style" type="text" value="${escapeHtml(info.style || (osmStyle || ''))}" class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft">
          <label for="building-description" class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Описание:</label>
          <textarea id="building-description" name="building-description" rows="3" class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200">${escapeHtml(info.description || '')}</textarea>
        </div>
        <div class="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-3">
          <p id="building-save-status" class="text-sm text-slate-600"></p>
          <button type="submit" class="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700">Сохранить</button>
        </div>
      </form>
    `
    : `
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Название:</b>${escapeHtml(shownName)}</div>
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Адрес:</b>${escapeHtml(shownAddress)}</div>
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Этажей:</b>${escapeHtml(shownLevels)}</div>
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Год постройки:</b>${escapeHtml(shownYear)}</div>
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Архитектор:</b>${escapeHtml(shownArchitect)}</div>
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Архитектурный стиль:</b>${escapeHtml(shownStyle)}</div>
      <div class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-slate-700 shadow-soft"><b class="mr-2 inline-block min-w-[220px] font-bold text-slate-900">Описание:</b>${escapeHtml(info.description || '-')}</div>
      <div class="rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm text-slate-700">
        Для редактирования войдите через кнопку в левом нижнем углу.
      </div>
    `;

  return `
    <div class="grid gap-2.5">
      ${editableRows}
      <details class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft">
        <summary class="relative cursor-pointer list-none bg-slate-50 px-3.5 py-3 pr-10 font-bold text-slate-900 transition hover:bg-slate-100 after:absolute after:right-3 after:top-1/2 after:-translate-y-1/2 after:content-['▾'] [&::-webkit-details-marker]:hidden [&[open]_summary]:after:rotate-180">OSM теги</summary>
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

function openModal(feature) {
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
    writeBuildingToUrl(parsed.osmType, parsed.osmId);
  }
}

function closeModal() {
  modalEl.classList.add('hidden');
  modalEl.setAttribute('aria-hidden', 'true');
  clearBuildingFromUrl();
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
    const changesHtml = item.changes.map((change) => `
      <div class="rounded-lg border border-slate-200 bg-white p-2.5">
        <div class="mb-1 flex items-center justify-between gap-2">
          <div class="text-xs font-semibold text-slate-600">${escapeHtml(change.label)}</div>
          <div class="text-[11px] font-semibold ${change.isLocalTag ? 'text-rose-600' : 'text-slate-500'}">
            ${change.isLocalTag ? 'Локальный тег' : `OSM: ${escapeHtml(change.osmTag || '—')}`}
          </div>
        </div>
        <div class="grid gap-1 md:grid-cols-2 md:gap-2">
          <div class="rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-700"><span class="font-semibold text-slate-500">OSM:</span> ${escapeHtml(formatChangeValue(change.osmValue))}</div>
          <div class="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900"><span class="font-semibold text-amber-700">Стало:</span> ${escapeHtml(formatChangeValue(change.localValue))}</div>
        </div>
      </div>
    `).join('');

    return `
      <article class="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div class="mb-2 flex items-start justify-between gap-2">
          <div class="text-sm font-semibold text-slate-900">${escapeHtml(item.osmType)}/${escapeHtml(item.osmId)}</div>
          <a class="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100" href="?b=${encodeURIComponent(`${item.osmType}/${item.osmId}`)}${window.location.hash || ''}">Открыть</a>
        </div>
        <div class="mb-2 text-xs text-slate-600">Изменил: <b class="text-slate-900">${escapeHtml(item.updatedBy || '—')}</b> • ${escapeHtml(formatUpdatedAt(item.updatedAt))}</div>
        <div class="space-y-2">${changesHtml}</div>
      </article>
    `;
  }).join('');
}

async function loadAdminEdits() {
  if (!adminEditsStatusEl || !adminEditsListEl) return;
  adminEditsStatusEl.textContent = 'Загрузка...';
  adminEditsListEl.innerHTML = '';

  const resp = await fetch('/api/admin/building-edits');
  if (!resp.ok) {
    adminEditsStatusEl.textContent = 'Не удалось загрузить список правок.';
    return;
  }

  const data = await resp.json().catch(() => ({ total: 0, items: [] }));
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) {
    adminEditsStatusEl.textContent = 'Локальные правки не найдены.';
    return;
  }

  adminEditsStatusEl.textContent = `Найдено правок: ${items.length}`;
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

async function selectBuildingFeature(feature) {
  normalizeFeatureInfo(feature);
  const parsed = parseKey(feature.properties?.osm_key);
  if (!parsed) return;

  selected = {
    ...parsed,
    feature
  };

  setSelectedFeature(feature);
  openModal(feature);
}

async function loadBuildingsByViewport() {
  if (!map.getSource('local-buildings')) return;

  if (map.getZoom() < MIN_BUILDING_ZOOM) {
    visibleTileKeys = new Set();
    currentBuildingsGeojson = { type: 'FeatureCollection', features: [] };
    map.getSource('local-buildings').setData(currentBuildingsGeojson);
    refreshTagKeysDatalist();
    applyFiltersToCurrentData();
    return;
  }

  const seq = ++loadRequestSeq;
  const keys = getVisibleTileKeys();
  visibleTileKeys = new Set(keys);

  const missingKeys = keys.filter((key) => !tileCache.has(key));
  const BATCH = 8;

  for (let i = 0; i < missingKeys.length; i += BATCH) {
    const chunk = missingKeys.slice(i, i + BATCH);
    await Promise.all(chunk.map(async (key) => {
      const [z, x, y] = key.split('/').map(Number);
      try {
        const resp = await fetch(`/api/buildings-tile/${z}/${x}/${y}`);
        if (!resp.ok) return;
        const geojson = await resp.json();
        if (!geojson || !Array.isArray(geojson.features)) return;
        touchTileCacheEntry(key, { geojson, ts: Date.now() });
      } catch {
        // keep map responsive if one tile fails
      }
    }));
    if (seq !== loadRequestSeq) return;
  }

  for (const key of keys) {
    const entry = tileCache.get(key);
    if (entry) touchTileCacheEntry(key, entry);
  }
  pruneTileCache();

  rebuildCurrentBuildingsFromVisibleTiles();
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
    authStatusEl.textContent = 'Ошибка авторизации';
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

if (filterToggleBtnEl) {
  filterToggleBtnEl.addEventListener('click', openFilterPanel);
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
    setLabelsVisibility(Boolean(labelsToggleEl.checked));
  });
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
  if (statusEl) statusEl.textContent = 'Сохраняем...';

  const formData = new FormData(form);
  const yearRaw = String(formData.get('building-year') || '').trim();
  const levelsRaw = String(formData.get('building-levels') || '').trim();

  const payload = {
    osmType: selected.osmType,
    osmId: selected.osmId,
    name: String(formData.get('building-name') || '').trim(),
    style: String(formData.get('building-style') || '').trim(),
    levels: levelsRaw,
    yearBuilt: yearRaw,
    architect: String(formData.get('building-architect') || '').trim(),
    address: String(formData.get('building-address') || '').trim(),
    description: String(formData.get('building-description') || '').trim()
  };

  const resp = await fetch('/api/building-info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'Не удалось сохранить' }));
    if (statusEl) statusEl.textContent = err.error || 'Не удалось сохранить';
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
  if (nextStatusEl) nextStatusEl.textContent = 'Сохранено';
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
    touchedCurrent = true;
  }

  if (touchedCurrent) {
    const source = map.getSource('local-buildings');
    if (source) source.setData(currentBuildingsGeojson);
  }

  for (const entry of tileCache.values()) {
    const features = entry?.geojson?.features;
    if (!Array.isArray(features)) continue;
    for (const feature of features) {
      if (String(feature?.properties?.osm_key || feature?.id || '') !== key) continue;
      applySavedInfoToFeature(feature, archiInfo);
    }
  }
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
    map.addSource('local-buildings', {
      type: 'geojson',
      data: currentBuildingsGeojson
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

  const buildingsSource = map.getSource('local-buildings');
  if (buildingsSource) buildingsSource.setData(currentBuildingsGeojson);
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

  try {
    await selectBuildingFeature(feature);
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
    setLabelsVisibility(Boolean(labelsToggleEl.checked));
  }
});

map.on('load', async () => {
  await loadAuthState();

  scheduleLoadBuildings();
  if (filterRowsEl && filterRowsEl.children.length === 0) {
    addFilterRow();
  }

  const buildingFromUrl = readBuildingFromUrl();
  if (buildingFromUrl) {
    const feature = await fetchBuildingById(buildingFromUrl.osmType, buildingFromUrl.osmId);
    if (feature) {
      normalizeFeatureInfo(feature);
      await selectBuildingFeature(feature);
    }
  }
});

map.on('moveend', scheduleLoadBuildings);
map.on('zoomend', scheduleLoadBuildings);
map.on('moveend', writeViewToUrl);
map.on('zoomend', writeViewToUrl);
