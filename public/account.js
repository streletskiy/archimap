let csrfToken = null;
let ownEditsCache = [];
let accountMap = null;
let highlightedEditKeys = new Set();
const I18N_RU = window.__ARCHIMAP_I18N_RU || {};
const UI_TEXT = Object.freeze(I18N_RU.ui || {});

const accountSubtitleEl = document.getElementById('account-subtitle');
const navLogoLinkEl = document.getElementById('nav-logo-link');
const mapReturnLinkEl = document.getElementById('map-return-link');
const mapReturnMenuLinkEl = document.getElementById('map-return-menu-link');
const adminLinkEl = document.getElementById('admin-link');
const uiKitLinkEl = document.getElementById('ui-kit-link');
const logoutBtnEl = document.getElementById('settings-logout-btn');
const settingsBuildLinkEl = document.getElementById('settings-build-link');
const settingsBuildTextEl = document.getElementById('settings-build-text');
const themeToggleEl = document.getElementById('theme-toggle');
const navMenuButtonEl = document.getElementById('nav-menu-button');
const navMenuPanelEl = document.getElementById('nav-menu-panel');
const tabSettingsEl = document.getElementById('account-tab-settings');
const tabEditsEl = document.getElementById('account-tab-edits');
const profilePanelEl = document.getElementById('account-profile-panel');
const editsPanelEl = document.getElementById('account-edits-panel');
const profileFormEl = document.getElementById('profile-form');
const firstNameEl = document.getElementById('first-name');
const lastNameEl = document.getElementById('last-name');
const profileEmailEl = document.getElementById('profile-email');
const profileStatusEl = document.getElementById('profile-status');
const passwordFormEl = document.getElementById('password-form');
const currentPasswordEl = document.getElementById('current-password');
const newPasswordEl = document.getElementById('new-password');
const newPasswordConfirmEl = document.getElementById('new-password-confirm');
const passwordStatusEl = document.getElementById('password-status');
const editsStatusEl = document.getElementById('account-edits-status');
const editsListEl = document.getElementById('account-edits-list');
const editsSearchEl = document.getElementById('account-edits-search');
const editsDateFilterEl = document.getElementById('account-edits-date-filter');
const editsMapEl = document.getElementById('account-edits-map');
const accountLayoutEl = document.getElementById('account-layout');
const editDetailPaneEl = document.getElementById('edit-detail-pane');
const editDetailCloseEl = document.getElementById('edit-detail-close');
const editDetailTitleEl = document.getElementById('edit-detail-title');
const editDetailMetaEl = document.getElementById('edit-detail-meta');
const editDetailListEl = document.getElementById('edit-detail-list');
const THEME_STORAGE_KEY = 'archimap-theme';
const LAST_MAP_HASH_STORAGE_KEY = 'archimap-last-map-hash';
const LIGHT_MAP_STYLE_URL = '/styles/positron-custom.json';
const DARK_MAP_STYLE_URL = '/styles/dark-matter-custom.json';
const PMTILES_CONFIG = Object.freeze({
  url: String(window.__ARCHIMAP_CONFIG?.buildingsPmtiles?.url || '/api/buildings.pmtiles'),
  sourceLayer: String(window.__ARCHIMAP_CONFIG?.buildingsPmtiles?.sourceLayer || 'buildings')
});
const BUILD_INFO_CONFIG = Object.freeze({
  shortSha: String(window.__ARCHIMAP_CONFIG?.buildInfo?.shortSha || 'unknown').trim() || 'unknown',
  version: String(window.__ARCHIMAP_CONFIG?.buildInfo?.version || 'dev').trim() || 'dev',
  repoUrl: String(window.__ARCHIMAP_CONFIG?.buildInfo?.repoUrl || 'https://github.com/streletskiy/archimap').trim() || 'https://github.com/streletskiy/archimap'
});

const nativeFetch = window.fetch.bind(window);
const accountState = { tab: 'settings', edit: '' };

function getUI() {
  return window.ArchiMapUI || null;
}

function t(key, params = null, fallback = '') {
  const template = Object.prototype.hasOwnProperty.call(UI_TEXT, key) ? UI_TEXT[key] : fallback;
  const base = String(template || fallback || '');
  if (!params || typeof params !== 'object') return base;
  return base.replace(/\{(\w+)\}/g, (_, name) => (params[name] == null ? '' : String(params[name])));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function parseEditKey(raw) {
  const value = String(raw || '').trim();
  if (!value.includes('/')) return null;
  const [osmType, osmIdRaw] = value.split('/');
  const osmId = Number(osmIdRaw);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId)) return null;
  return { osmType, osmId, key: `${osmType}/${osmId}` };
}

function isStateChangingMethod(method) {
  const m = String(method || 'GET').toUpperCase();
  return !['GET', 'HEAD', 'OPTIONS'].includes(m);
}

window.fetch = (input, init = {}) => {
  const nextInit = { ...init };
  const method = String(nextInit.method || (input?.method || 'GET')).toUpperCase();
  if (csrfToken && isStateChangingMethod(method)) {
    const headers = new Headers(nextInit.headers || {});
    if (!headers.has('x-csrf-token')) headers.set('x-csrf-token', csrfToken);
    nextInit.headers = headers;
  }
  return nativeFetch(input, nextInit);
};

function setText(el, text) {
  if (!el) return;
  el.textContent = String(text || '');
}

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // ignore
  }
  if (themeToggleEl) themeToggleEl.checked = next === 'dark';
  applyAccountMapTheme(next);
}

function initThemeToggle() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  if (themeToggleEl) {
    themeToggleEl.checked = current === 'dark';
    themeToggleEl.addEventListener('change', () => {
      applyTheme(themeToggleEl.checked ? 'dark' : 'light');
    });
  }
}

function initUiKitClasses() {
  const ui = getUI();
  if (!ui) return;
  if (typeof ui.fieldClass === 'function') {
    [firstNameEl, lastNameEl, profileEmailEl, currentPasswordEl, newPasswordEl, newPasswordConfirmEl, editsSearchEl, editsDateFilterEl].forEach((el) => {
      if (el) el.className = ui.fieldClass('input');
    });
    if (profileEmailEl) profileEmailEl.classList.add('text-slate-500');
  }
  if (typeof ui.buttonClass === 'function') {
    const saveButton = profileFormEl?.querySelector('button[type="submit"]');
    const passwordButton = passwordFormEl?.querySelector('button[type="submit"]');
    if (saveButton) saveButton.className = ui.buttonClass('primary');
    if (passwordButton) passwordButton.className = ui.buttonClass('outlineBrand');
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

function getMapReturnHref() {
  try {
    const hash = String(localStorage.getItem(LAST_MAP_HASH_STORAGE_KEY) || '').trim();
    return hash.startsWith('#map=') ? `/${hash}` : '/';
  } catch {
    return '/';
  }
}

function initMapReturnLinks() {
  const href = getMapReturnHref();
  if (navLogoLinkEl) navLogoLinkEl.setAttribute('href', href);
  if (mapReturnLinkEl) mapReturnLinkEl.setAttribute('href', href);
  if (mapReturnMenuLinkEl) mapReturnMenuLinkEl.setAttribute('href', href);
}

function setNavMenuOpen(open) {
  if (!navMenuButtonEl || !navMenuPanelEl) return;
  navMenuPanelEl.classList.toggle('opacity-0', !open);
  navMenuPanelEl.classList.toggle('pointer-events-none', !open);
  navMenuPanelEl.classList.toggle('max-h-0', !open);
  navMenuPanelEl.classList.toggle('-translate-y-2', !open);
  navMenuPanelEl.classList.toggle('scale-95', !open);
  navMenuPanelEl.classList.toggle('max-h-[420px]', open);
  navMenuPanelEl.classList.toggle('translate-y-0', open);
  navMenuPanelEl.classList.toggle('scale-100', open);
  navMenuButtonEl.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function initNavMenu() {
  if (!navMenuButtonEl || !navMenuPanelEl) return;
  setNavMenuOpen(false);

  navMenuButtonEl.addEventListener('click', (event) => {
    event.stopPropagation();
    const expanded = navMenuButtonEl.getAttribute('aria-expanded') === 'true';
    setNavMenuOpen(!expanded);
  });

  document.addEventListener('click', (event) => {
    if (!navMenuPanelEl.contains(event.target) && !navMenuButtonEl.contains(event.target)) {
      setNavMenuOpen(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setNavMenuOpen(false);
  });
}

function getLoginRedirectUrl() {
  return '/?auth=1&next=' + encodeURIComponent('/account/');
}

function readRegisterTokenFromUrl() {
  try {
    const url = new URL(window.location.href);
    return String(url.searchParams.get('registerToken') || '').trim() || null;
  } catch {
    return null;
  }
}

function clearRegisterTokenFromUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('registerToken');
    history.replaceState(null, '', url.toString());
  } catch {
    // ignore
  }
}

function readStateFromUrl() {
  try {
    const url = new URL(window.location.href);
    return {
      tab: String(url.searchParams.get('tab') || '').trim(),
      edit: String(url.searchParams.get('edit') || '').trim()
    };
  } catch {
    return { tab: '', edit: '' };
  }
}

function writeStateToUrl(options = {}) {
  const replace = Boolean(options.replace);
  const url = new URL(window.location.href);
  const setOrDelete = (key, value) => {
    const text = String(value || '').trim();
    if (!text) {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, text);
    }
  };
  setOrDelete('tab', accountState.tab);
  setOrDelete('edit', accountState.edit);
  if (replace) {
    history.replaceState(null, '', url.toString());
  } else {
    history.pushState(null, '', url.toString());
  }
}

function getNormalizedTab(raw) {
  const tab = String(raw || '').trim().toLowerCase();
  if (tab === 'settings' || tab === 'profile' || tab === 'security' || tab === 'notifications') return 'settings';
  if (tab === 'edits') return 'edits';
  return 'settings';
}

function setTabButtonState(button, active) {
  if (!button) return;
  const ui = getUI();
  if (ui && typeof ui.tabButtonClass === 'function') {
    button.className = ui.tabButtonClass(active);
    return;
  }
  button.className = active
    ? 'ui-tab-btn ui-tab-btn-active'
    : 'ui-tab-btn';
}

function setTab(nextTab, options = {}) {
  const push = options.push !== false;
  accountState.tab = getNormalizedTab(nextTab);

  if (profilePanelEl) profilePanelEl.classList.toggle('hidden', accountState.tab !== 'settings');
  if (editsPanelEl) editsPanelEl.classList.toggle('hidden', accountState.tab !== 'edits');

  setTabButtonState(tabSettingsEl, accountState.tab === 'settings');
  setTabButtonState(tabEditsEl, accountState.tab === 'edits');

  if (accountState.tab === 'edits') {
    const map = ensureAccountMap();
    if (map) {
      setTimeout(() => map.resize(), 0);
      applyEditedBuildingsPaint();
    }
  }

  if (push) writeStateToUrl();
}

async function loadMe() {
  const resp = await fetch('/api/me');
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.authenticated || !data?.user) {
    window.location.href = getLoginRedirectUrl();
    return null;
  }

  const user = data.user;
  csrfToken = String(data.csrfToken || '') || null;

  const fullName = [String(user.firstName || '').trim(), String(user.lastName || '').trim()].filter(Boolean).join(' ');
  const title = fullName || String(user.email || user.username || t('accountUserDefault', null, 'Пользователь'));
  const userEmail = String(user.email || user.username || t('accountEmailMissing', null, 'без email'));
  setText(accountSubtitleEl, `${title} (${userEmail})`);

  if (firstNameEl) firstNameEl.value = String(user.firstName || '');
  if (lastNameEl) lastNameEl.value = String(user.lastName || '');
  if (profileEmailEl) profileEmailEl.value = userEmail;

  if (adminLinkEl) adminLinkEl.classList.toggle('hidden', !Boolean(user.isAdmin));
  if (uiKitLinkEl) uiKitLinkEl.classList.toggle('hidden', !Boolean(user.isAdmin));
  return user;
}

async function confirmRegistrationTokenIfPresent() {
  const token = readRegisterTokenFromUrl();
  if (!token) return false;

  let resp;
  try {
    resp = await fetch('/api/register/confirm-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
  } catch {
    setText(accountSubtitleEl, t('authRegisterLinkNetworkError', null, 'Ошибка сети при подтверждении ссылки'));
    return false;
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    setText(accountSubtitleEl, String(data?.error || t('authRegisterLinkFailed', null, 'Не удалось подтвердить регистрацию')));
    clearRegisterTokenFromUrl();
    return false;
  }

  csrfToken = String(data?.csrfToken || '') || null;
  clearRegisterTokenFromUrl();
  return true;
}

function renderOwnEdits(items) {
  if (!editsListEl) return;
  if (!Array.isArray(items) || items.length === 0) {
    editsListEl.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-sm text-slate-600">${escapeHtml(t('adminEditsEmpty', null, 'Локальных правок нет.'))}</td></tr>`;
    return;
  }

  const statusBadge = (status) => {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'accepted') return `<span class="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">${escapeHtml(t('editStatusAccepted', null, 'Принято'))}</span>`;
    if (normalized === 'partially_accepted') return `<span class="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">${escapeHtml(t('editStatusPartiallyAccepted', null, 'Частично принято'))}</span>`;
    if (normalized === 'rejected') return `<span class="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-700">${escapeHtml(t('editStatusRejected', null, 'Отклонено'))}</span>`;
    if (normalized === 'superseded') return `<span class="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">${escapeHtml(t('editStatusSuperseded', null, 'Заменено новой правкой'))}</span>`;
    return `<span class="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">${escapeHtml(t('editStatusPending', null, 'На рассмотрении'))}</span>`;
  };

  editsListEl.innerHTML = items.map((item) => {
    const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`;
    const editId = Number(item?.editId || 0);
    const address = getEditAddress(item);
    const author = String(item?.updatedBy || '-');
    const counters = getChangeCounters(item?.changes);
    const comment = String(item?.adminComment || '').trim();
    return `
      <tr data-action="open-edit" data-edit-key="${escapeHtml(osmKey)}" data-edit-id="${escapeHtml(editId)}" class="cursor-pointer border-t border-slate-200 hover:bg-slate-50">
        <td class="px-4 py-3">
          <p class="font-semibold text-slate-900">${escapeHtml(address)}</p>
          <p class="text-xs text-slate-500">ID: ${escapeHtml(osmKey)}</p>
          ${comment ? `<p class="mt-1 text-xs text-rose-600">${escapeHtml(t('editCommentLabel', { text: comment }, `Комментарий: ${comment}`))}</p>` : ''}
        </td>
        <td class="px-4 py-3">${escapeHtml(author)}</td>
        <td class="px-4 py-3">${statusBadge(item?.status)}</td>
        <td class="px-4 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">${escapeHtml(t('editCountersTotal', { count: counters.total }, `${counters.total} всего`))}</span>
            ${counters.created > 0 ? `<span class="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-600">${escapeHtml(t('editCountersCreated', { count: counters.created }, `+${counters.created} создано`))}</span>` : ''}
            ${counters.modified > 0 ? `<span class="rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-600">${escapeHtml(t('editCountersModified', { count: counters.modified }, `~${counters.modified} изменено`))}</span>` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function getEditAddress(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const addressChange = changes.find((change) => change?.field === 'address');
  if (addressChange?.localValue) return String(addressChange.localValue);
  if (addressChange?.osmValue) return String(addressChange.osmValue);
  if (item?.local?.address) return String(item.local.address);
  return `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`;
}

function getChangeCounters(changes) {
  const list = Array.isArray(changes) ? changes : [];
  let created = 0;
  let modified = 0;
  for (const change of list) {
    if (change?.osmValue == null && change?.localValue != null) {
      created += 1;
    } else {
      modified += 1;
    }
  }
  return { total: list.length, created, modified };
}

function syncMapHighlightsWithEdits(items) {
  highlightedEditKeys = new Set(
    (Array.isArray(items) ? items : []).map((item) => `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`)
  );
  applyEditedBuildingsPaint();
}

function applyOwnEditsFilters() {
  const query = String(editsSearchEl?.value || '').trim().toLowerCase();
  const date = String(editsDateFilterEl?.value || '').trim();
  const filtered = ownEditsCache.filter((item) => {
    const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`.toLowerCase();
    const address = getEditAddress(item).toLowerCase();
    const updatedAt = String(item?.updatedAt || '');
    if (query && !address.includes(query) && !osmKey.includes(query)) return false;
    if (date && !updatedAt.startsWith(date)) return false;
    return true;
  });
  setText(editsStatusEl, t('editsShownSummary', { shown: filtered.length, total: ownEditsCache.length }, `Показано: ${filtered.length} из ${ownEditsCache.length}`));
  renderOwnEdits(filtered);
  syncMapHighlightsWithEdits(filtered);
}

async function loadOwnEdits() {
  setText(editsStatusEl, t('adminEditsLoading', null, 'Загрузка...'));
  let resp;
  try {
    resp = await fetch('/api/account/edits');
  } catch {
    setText(editsStatusEl, t('adminEditsNetworkError', null, 'Ошибка сети'));
    return;
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    setText(editsStatusEl, String(data?.error || t('adminEditsLoadFailed', null, 'Не удалось загрузить правки')));
    return;
  }

  ownEditsCache = Array.isArray(data.items) ? data.items : [];
  applyOwnEditsFilters();
  ensureAccountMap();
}

function getMapStyleForTheme(theme) {
  return theme === 'dark' ? DARK_MAP_STYLE_URL : LIGHT_MAP_STYLE_URL;
}

function ensureAccountMapLayers() {
  if (!accountMap) return;
  if (!accountMap.getSource('local-buildings')) {
    const pmtilesUrl = PMTILES_CONFIG.url.startsWith('http')
      ? PMTILES_CONFIG.url
      : `${window.location.origin}${PMTILES_CONFIG.url.startsWith('/') ? '' : '/'}${PMTILES_CONFIG.url}`;
    accountMap.addSource('local-buildings', { type: 'vector', url: `pmtiles://${pmtilesUrl}` });
  }
  if (!accountMap.getSource('selected-building')) {
    accountMap.addSource('selected-building', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
  }
  if (!accountMap.getLayer('local-buildings-fill')) {
    accountMap.addLayer({
      id: 'local-buildings-fill',
      type: 'fill',
      source: 'local-buildings',
      'source-layer': PMTILES_CONFIG.sourceLayer,
      minzoom: 13,
      paint: { 'fill-color': '#9ca3af', 'fill-opacity': 0.35 }
    });
  }
  if (!accountMap.getLayer('local-buildings-line')) {
    accountMap.addLayer({
      id: 'local-buildings-line',
      type: 'line',
      source: 'local-buildings',
      'source-layer': PMTILES_CONFIG.sourceLayer,
      minzoom: 13,
      paint: { 'line-color': '#6b7280', 'line-width': 0.8 }
    });
  }
  if (!accountMap.getLayer('edited-buildings-fill')) {
    accountMap.addLayer({
      id: 'edited-buildings-fill',
      type: 'fill',
      source: 'local-buildings',
      'source-layer': PMTILES_CONFIG.sourceLayer,
      minzoom: 13,
      paint: { 'fill-color': '#5B62F0', 'fill-opacity': 0 }
    });
  }
  if (!accountMap.getLayer('edited-buildings-line')) {
    accountMap.addLayer({
      id: 'edited-buildings-line',
      type: 'line',
      source: 'local-buildings',
      'source-layer': PMTILES_CONFIG.sourceLayer,
      minzoom: 13,
      paint: { 'line-color': 'rgba(0,0,0,0)', 'line-width': 0 }
    });
  }
  if (!accountMap.getLayer('selected-building-fill')) {
    accountMap.addLayer({
      id: 'selected-building-fill',
      type: 'fill',
      source: 'selected-building',
      paint: { 'fill-color': '#5B62F0', 'fill-opacity': 0.24 }
    });
  }
  if (!accountMap.getLayer('selected-building-line')) {
    accountMap.addLayer({
      id: 'selected-building-line',
      type: 'line',
      source: 'selected-building',
      paint: { 'line-color': '#5B62F0', 'line-width': 3 }
    });
  }
  applyEditedBuildingsPaint();
}

function ensureAccountMap() {
  if (accountMap || !editsMapEl) return accountMap;
  if (typeof window.maplibregl === 'undefined' || typeof window.pmtiles === 'undefined') {
    editsMapEl.innerHTML = `<div class="flex h-full items-center justify-center text-sm text-slate-500">${escapeHtml(t('mapLibLoadFailed', null, 'MapLibre/PMTiles не загружены'))}</div>`;
    return null;
  }
  const protocol = new window.pmtiles.Protocol();
  window.maplibregl.addProtocol('pmtiles', protocol.tile);

  accountMap = new window.maplibregl.Map({
    container: editsMapEl,
    style: getMapStyleForTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'),
    center: [44.0059, 56.3269],
    zoom: 14
  });
  accountMap.addControl(new window.maplibregl.NavigationControl(), 'top-right');
  accountMap.on('style.load', () => {
    ensureAccountMapLayers();
    applyEditedBuildingsPaint();
  });
  accountMap.on('load', () => {
    ensureAccountMapLayers();
    applyEditedBuildingsPaint();
  });
  return accountMap;
}

function applyAccountMapTheme(theme) {
  if (!accountMap) return;
  accountMap.setStyle(getMapStyleForTheme(theme));
}

function getEditedKeysExpression() {
  const encodedIds = [];
  for (const key of highlightedEditKeys) {
    const [osmType, osmIdRaw] = String(key).split('/');
    const osmId = Number(osmIdRaw);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) continue;
    const typeBit = osmType === 'relation' ? 1 : 0;
    encodedIds.push((osmId * 2) + typeBit);
  }
  return ['in', ['id'], ['literal', encodedIds]];
}

function applyEditedBuildingsPaint() {
  if (!accountMap) return;
  const keyMatchExpr = getEditedKeysExpression();
  if (accountMap.getLayer('edited-buildings-fill')) {
    accountMap.setPaintProperty('edited-buildings-fill', 'fill-opacity', ['case', keyMatchExpr, 0.28, 0]);
  }
  if (accountMap.getLayer('edited-buildings-line')) {
    accountMap.setPaintProperty('edited-buildings-line', 'line-color', ['case', keyMatchExpr, '#5B62F0', 'rgba(0,0,0,0)']);
    accountMap.setPaintProperty('edited-buildings-line', 'line-width', ['case', keyMatchExpr, 2.2, 0]);
  }
}

function extendBoundsFromCoords(bounds, coords) {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    bounds.extend([coords[0], coords[1]]);
    return;
  }
  for (const value of coords) extendBoundsFromCoords(bounds, value);
}

async function updateDetailMapFeature(feature) {
  const map = ensureAccountMap();
  if (!map || !feature) return;

  const apply = () => {
    const source = map.getSource('selected-building');
    if (!source) return;
    source.setData(feature);
    const bounds = new window.maplibregl.LngLatBounds();
    extendBoundsFromCoords(bounds, feature?.geometry?.coordinates);
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 60, duration: 450, maxZoom: 18 });
    }
  };

  if (map.loaded()) apply();
  else map.once('load', apply);
}

function closeEditModal(options = {}) {
  const push = options.push !== false;
  accountState.edit = '';
  if (editDetailPaneEl) editDetailPaneEl.classList.add('hidden');
  if (accountLayoutEl) accountLayoutEl.classList.remove('edit-pane-open');
  if (push) writeStateToUrl();
}

function renderDiffItem(change) {
  const oldValue = change?.osmValue == null ? t('diffEmptyValue', null, 'пусто') : String(change.osmValue);
  const newValue = change?.localValue == null ? t('diffEmptyValue', null, 'пусто') : String(change.localValue);
  const isNew = change?.osmValue == null && change?.localValue != null;
  const valueClass = isNew ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700';
  return `
    <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p class="text-sm font-semibold text-slate-900">${escapeHtml(String(change?.label || '-'))}:</p>
      <div class="mt-1 flex flex-wrap items-center gap-2 text-sm">
        <span class="text-slate-500 line-through">${escapeHtml(oldValue)}</span>
        <span class="text-slate-400">-&gt;</span>
        <span class="rounded-md px-2 py-1 ${valueClass}">${escapeHtml(newValue)}</span>
      </div>
    </div>
  `;
}

function parseEditId(raw) {
  const id = Number(String(raw || '').trim());
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

async function openEditDetails(editIdRaw, options = {}) {
  const push = options.push !== false;
  const editId = parseEditId(editIdRaw);
  if (!editId) return;
  setTab('edits', { push: false });

  let resp;
  try {
    resp = await fetch(`/api/account/edits/${encodeURIComponent(editId)}`);
  } catch {
    return;
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.item) return;

  const item = data.item;
  const editKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`;
  accountState.edit = String(editId);
  if (push) writeStateToUrl();

  if (editDetailTitleEl) editDetailTitleEl.textContent = getEditAddress(item);
  if (editDetailMetaEl) editDetailMetaEl.textContent = `${t('accountMetaStatus', { status: String(item.status || 'pending') }, `Статус: ${String(item.status || 'pending')}`)} | ${String(item.updatedAt || '-')}`;
  if (editDetailListEl) {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    editDetailListEl.innerHTML = changes.length === 0
      ? `<p class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">${escapeHtml(t('adminNoChanges', null, 'Без изменений'))}</p>`
      : changes.map(renderDiffItem).join('');
  }
  if (editDetailPaneEl) editDetailPaneEl.classList.remove('hidden');
  if (accountLayoutEl) accountLayoutEl.classList.add('edit-pane-open');
  let building = null;
  try {
    const buildingResp = await fetch(`/api/building/${encodeURIComponent(item.osmType)}/${encodeURIComponent(item.osmId)}`);
    building = await buildingResp.json().catch(() => ({}));
  } catch {
    building = null;
  }
  if (building?.type === 'Feature' && building?.geometry) {
    await updateDetailMapFeature(building);
  }
  highlightedEditKeys = new Set([editKey]);
  applyEditedBuildingsPaint();
}

if (profileFormEl) {
  profileFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    setText(profileStatusEl, t('accountProfileSaving', null, 'Сохраняем...'));

    const firstName = String(firstNameEl?.value || '').trim();
    const lastName = String(lastNameEl?.value || '').trim();

    let resp;
    try {
      resp = await fetch('/api/account/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName })
      });
    } catch {
      setText(profileStatusEl, t('accountProfileNetworkError', null, 'Ошибка сети'));
      return;
    }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      setText(profileStatusEl, String(data?.error || t('accountProfileSaveFailed', null, 'Не удалось сохранить профиль')));
      return;
    }

    setText(profileStatusEl, t('accountProfileSaved', null, 'Профиль сохранен'));
    await loadMe();
  });
}

if (passwordFormEl) {
  passwordFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const currentPassword = String(currentPasswordEl?.value || '');
    const newPassword = String(newPasswordEl?.value || '');
    const confirm = String(newPasswordConfirmEl?.value || '');

    if (!currentPassword || !newPassword) {
      setText(passwordStatusEl, t('accountPasswordFillRequired', null, 'Введите текущий и новый пароль'));
      return;
    }
    if (newPassword !== confirm) {
      setText(passwordStatusEl, t('accountPasswordMismatch', null, 'Новые пароли не совпадают'));
      return;
    }

    setText(passwordStatusEl, t('accountPasswordSaving', null, 'Меняем пароль...'));

    let resp;
    try {
      resp = await fetch('/api/account/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
    } catch {
      setText(passwordStatusEl, t('accountPasswordNetworkError', null, 'Ошибка сети'));
      return;
    }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      setText(passwordStatusEl, String(data?.error || t('accountPasswordFailed', null, 'Не удалось сменить пароль')));
      return;
    }

    setText(passwordStatusEl, t('accountPasswordSaved', null, 'Пароль успешно изменен'));
    passwordFormEl.reset();
  });
}

if (tabSettingsEl) tabSettingsEl.addEventListener('click', () => setTab('settings'));
if (tabEditsEl) {
  tabEditsEl.addEventListener('click', async () => {
    setTab('edits');
    await loadOwnEdits();
  });
}

for (const el of [editsSearchEl, editsDateFilterEl]) {
  if (!el) continue;
  const eventName = el === editsSearchEl ? 'input' : 'change';
  el.addEventListener(eventName, () => {
    applyOwnEditsFilters();
  });
}

if (editsListEl) {
  editsListEl.addEventListener('click', async (event) => {
    const actionEl = event.target?.closest?.('[data-action="open-edit"]');
    if (!actionEl) return;
    const editId = String(actionEl.getAttribute('data-edit-id') || '').trim();
    await openEditDetails(editId);
  });
}

if (editDetailCloseEl) editDetailCloseEl.addEventListener('click', () => closeEditModal());

if (logoutBtnEl) {
  logoutBtnEl.classList.remove('hidden');
  logoutBtnEl.addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    window.location.href = '/';
  });
}

async function restoreFromUrl() {
  const fromUrl = readStateFromUrl();
  accountState.tab = getNormalizedTab(fromUrl.tab);
  accountState.edit = String(fromUrl.edit || '').trim();
  setTab(accountState.tab, { push: false });
  writeStateToUrl({ replace: true });

  if (accountState.tab === 'edits') {
    await loadOwnEdits();
  }
  if (accountState.edit) {
    await openEditDetails(accountState.edit, { push: false });
  }
}

window.addEventListener('popstate', async () => {
  await restoreFromUrl();
});

(async () => {
  initUiKitClasses();
  renderBuildInfoLink();
  initThemeToggle();
  initNavMenu();
  initMapReturnLinks();
  await confirmRegistrationTokenIfPresent();
  await loadMe();
  await restoreFromUrl();
})();
