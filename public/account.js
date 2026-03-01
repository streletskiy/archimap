let csrfToken = null;
let ownEditsCache = [];
let accountMap = null;
let highlightedEditKeys = new Set();
let accountMapHandlersBound = false;
let accountEditedPointsUpdateSeq = 0;
const accountEditIdByOsmKey = new Map();
const accountEditedCenterByOsmKey = new Map();
const accountEditedFeaturePromiseByOsmKey = new Map();
const EDITS_CONTOUR_MIN_ZOOM = 13;
const EDITED_POINTS_SOURCE_ID = 'edited-buildings-points';
const EDITED_POINTS_CLUSTER_LAYER_ID = 'edited-buildings-points-clusters';
const EDITED_POINTS_CLUSTER_COUNT_LAYER_ID = 'edited-buildings-points-cluster-count';
const EDITED_POINTS_UNCLUSTERED_LAYER_ID = 'edited-buildings-points-unclustered';
const textTools = window.ArchiMapTextUtils?.createUiTextTools
  ? window.ArchiMapTextUtils.createUiTextTools()
  : null;
const t = textTools?.t || ((_, __, fallback = '') => String(fallback || ''));
const escapeHtml = textTools?.escapeHtml || ((value) => String(value ?? ''));
const panelPageUtils = window.ArchiMapPanelPage || {};

const accountSubtitleEl = document.getElementById('account-subtitle');
const accountPageTitleEl = document.getElementById('account-page-title');
const accountHeadingEl = document.getElementById('account-heading');
const accountSettingsTitleEl = document.getElementById('account-settings-title');
const accountSettingsHintEl = document.getElementById('account-settings-hint');
const accountPersonalTitleEl = document.getElementById('account-personal-title');
const accountLabelFirstNameEl = document.getElementById('account-label-first-name');
const accountLabelLastNameEl = document.getElementById('account-label-last-name');
const accountLabelEmailEl = document.getElementById('account-label-email');
const accountProfileSaveBtnEl = document.getElementById('account-profile-save-btn');
const accountSecurityTitleEl = document.getElementById('account-security-title');
const accountLabelCurrentPasswordEl = document.getElementById('account-label-current-password');
const accountLabelNewPasswordEl = document.getElementById('account-label-new-password');
const accountLabelNewPasswordConfirmEl = document.getElementById('account-label-new-password-confirm');
const accountPasswordSaveBtnEl = document.getElementById('account-password-save-btn');
const accountNotificationsTitleEl = document.getElementById('account-notifications-title');
const accountNotifyCommentsTitleEl = document.getElementById('account-notify-comments-title');
const accountNotifyCommentsHintEl = document.getElementById('account-notify-comments-hint');
const accountNotifyModerationTitleEl = document.getElementById('account-notify-moderation-title');
const accountNotifyModerationHintEl = document.getElementById('account-notify-moderation-hint');
const accountNotifyWeeklyTitleEl = document.getElementById('account-notify-weekly-title');
const accountNotifyWeeklyHintEl = document.getElementById('account-notify-weekly-hint');
const accountEditsColObjectEl = document.getElementById('account-edits-col-object');
const accountEditsColAuthorEl = document.getElementById('account-edits-col-author');
const accountEditsColStatusEl = document.getElementById('account-edits-col-status');
const accountEditsColChangesEl = document.getElementById('account-edits-col-changes');
const navLogoLinkEl = document.getElementById('nav-logo-link');
const mapReturnLinkEl = document.getElementById('map-return-link');
const mapReturnMenuLinkEl = document.getElementById('map-return-menu-link');
const adminLinkEl = document.getElementById('admin-link');
const uiKitLinkEl = document.getElementById('ui-kit-link');
const logoutBtnEl = document.getElementById('settings-logout-btn');
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
const accountLegalTitleEl = document.getElementById('account-legal-title');
const accountLegalHintEl = document.getElementById('account-legal-hint');
const accountLegalUserAgreementLinkEl = document.getElementById('account-legal-user-agreement-link');
const accountLegalPrivacyLinkEl = document.getElementById('account-legal-privacy-link');
const LIGHT_MAP_STYLE_URL = '/styles/positron-custom.json';
const DARK_MAP_STYLE_URL = '/styles/dark-matter-custom.json';
const PMTILES_CONFIG = Object.freeze({
  url: String(window.__ARCHIMAP_CONFIG?.buildingsPmtiles?.url || '/api/buildings.pmtiles'),
  sourceLayer: String(window.__ARCHIMAP_CONFIG?.buildingsPmtiles?.sourceLayer || 'buildings')
});

const nativeFetch = window.fetch.bind(window);
const accountState = { tab: 'settings', edit: '' };

function getUI() {
  return window.ArchiMapUI || null;
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
    localStorage.setItem('archimap-theme', next);
  } catch {
    // ignore
  }
  if (themeToggleEl) themeToggleEl.checked = next === 'dark';
  applyAccountMapTheme(next);
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
    if (logoutBtnEl) logoutBtnEl.className = ui.buttonClass('danger') + ' hidden';
  }
}

function applyLegalSectionTexts() {
  setText(accountLegalTitleEl, t('accountLegalTitle', null, 'Правовая информация'));
  setText(accountLegalHintEl, t('accountLegalHint', null, 'Соглашения и политика конфиденциальности доступны в разделе информации.'));
  setText(accountLegalUserAgreementLinkEl, t('infoTabUserAgreement', null, 'Пользовательское соглашение'));
  setText(accountLegalPrivacyLinkEl, t('infoTabPrivacyPolicy', null, 'Политика конфиденциальности'));
}

function applyAccountStaticTexts() {
  setText(accountPageTitleEl, t('accountPageTitle', null, 'Личный кабинет | archimap'));
  setText(accountHeadingEl, t('accountHeading', null, 'Личный кабинет'));
  setText(tabSettingsEl, t('accountTabSettings', null, 'Настройки'));
  setText(tabEditsEl, t('accountTabEdits', null, 'Мои правки'));
  setText(accountSettingsTitleEl, t('accountSettingsTitle', null, 'Настройки профиля'));
  setText(accountSettingsHintEl, t('accountSettingsHint', null, 'Личные данные, безопасность и уведомления в одном разделе.'));
  setText(accountPersonalTitleEl, t('accountPersonalTitle', null, 'Личные данные'));
  setText(accountLabelFirstNameEl, t('accountLabelFirstName', null, 'Имя'));
  setText(accountLabelLastNameEl, t('accountLabelLastName', null, 'Фамилия'));
  setText(accountLabelEmailEl, t('accountLabelEmail', null, 'Email'));
  setText(accountProfileSaveBtnEl, t('accountProfileSaveBtn', null, 'Сохранить'));
  setText(accountSecurityTitleEl, t('accountSecurityTitle', null, 'Безопасность'));
  setText(accountLabelCurrentPasswordEl, t('accountLabelCurrentPassword', null, 'Текущий пароль'));
  setText(accountLabelNewPasswordEl, t('accountLabelNewPassword', null, 'Новый пароль'));
  setText(accountLabelNewPasswordConfirmEl, t('accountLabelNewPasswordConfirm', null, 'Повторите новый пароль'));
  setText(accountPasswordSaveBtnEl, t('accountPasswordSaveBtn', null, 'Изменить пароль'));
  setText(accountNotificationsTitleEl, t('accountNotificationsTitle', null, 'Уведомления'));
  setText(accountNotifyCommentsTitleEl, t('accountNotifyCommentsTitle', null, 'Новые комментарии к правкам'));
  setText(accountNotifyCommentsHintEl, t('accountNotifyCommentsHint', null, 'Письмо, когда администратор комментирует вашу правку.'));
  setText(accountNotifyModerationTitleEl, t('accountNotifyModerationTitle', null, 'Статус модерации'));
  setText(accountNotifyModerationHintEl, t('accountNotifyModerationHint', null, 'Уведомления об одобрении или отклонении изменений.'));
  setText(accountNotifyWeeklyTitleEl, t('accountNotifyWeeklyTitle', null, 'Еженедельная сводка'));
  setText(accountNotifyWeeklyHintEl, t('accountNotifyWeeklyHint', null, 'Подборка ваших активностей и новых объектов на карте.'));
  if (editsSearchEl) editsSearchEl.placeholder = t('accountEditsSearchPlaceholder', null, 'Поиск по адресу или ID здания');
  if (editsStatusEl) editsStatusEl.textContent = t('adminEditsLoading', null, 'Загрузка...');
  setText(accountEditsColObjectEl, t('accountEditsColObject', null, 'Объект'));
  setText(accountEditsColAuthorEl, t('accountEditsColAuthor', null, 'Автор'));
  setText(accountEditsColStatusEl, t('accountEditsColStatus', null, 'Статус'));
  setText(accountEditsColChangesEl, t('accountEditsColChanges', null, 'Изменения тегов'));
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
      ensureEditedPointsAndFit([...highlightedEditKeys]);
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
  if (logoutBtnEl) logoutBtnEl.classList.remove('hidden');

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
  if (item?.values?.address) return String(item.values.address);
  if (item?.local?.address) return String(item.local.address);
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const addressChange = changes.find((change) => change?.field === 'address');
  if (addressChange?.localValue) return String(addressChange.localValue);
  if (addressChange?.osmValue) return String(addressChange.osmValue);
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
  const keys = [];
  accountEditIdByOsmKey.clear();
  for (const item of Array.isArray(items) ? items : []) {
    const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`;
    const editId = Number(item?.editId || 0);
    if (!accountEditIdByOsmKey.has(osmKey) && editId > 0) {
      accountEditIdByOsmKey.set(osmKey, editId);
    }
    keys.push(osmKey);
  }
  highlightedEditKeys = new Set(keys);
  applyEditedBuildingsPaint();
  ensureEditedPointsAndFit([...highlightedEditKeys]);
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

function parseOsmKey(osmKey) {
  const [osmType, osmIdRaw] = String(osmKey || '').split('/');
  const osmId = Number(osmIdRaw);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) return null;
  return { osmType, osmId };
}

function decodeOsmKeyFromEncodedFeatureId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  const osmType = (id % 2) === 1 ? 'relation' : 'way';
  const osmId = Math.floor(id / 2);
  if (!Number.isInteger(osmId) || osmId <= 0) return null;
  return `${osmType}/${osmId}`;
}

function getGeometryCenter(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const bounds = new window.maplibregl.LngLatBounds();
  extendBoundsFromCoords(bounds, geometry.coordinates);
  if (bounds.isEmpty()) return null;
  const center = bounds.getCenter();
  if (!Number.isFinite(center?.lng) || !Number.isFinite(center?.lat)) return null;
  return [center.lng, center.lat];
}

async function fetchBuildingFeatureByOsmKey(osmKey) {
  const parsed = parseOsmKey(osmKey);
  if (!parsed) return null;
  const cached = accountEditedCenterByOsmKey.get(osmKey);
  if (cached) return cached;

  const pending = accountEditedFeaturePromiseByOsmKey.get(osmKey);
  if (pending) return pending;

  const task = (async () => {
    let resp;
    try {
      resp = await fetch(`/api/building/${encodeURIComponent(parsed.osmType)}/${encodeURIComponent(parsed.osmId)}`);
    } catch {
      return null;
    }
    if (!resp.ok) return null;
    const feature = await resp.json().catch(() => null);
    if (!feature?.geometry) return null;
    const center = getGeometryCenter(feature.geometry);
    if (!center) return null;
    accountEditedCenterByOsmKey.set(osmKey, center);
    return center;
  })().finally(() => {
    accountEditedFeaturePromiseByOsmKey.delete(osmKey);
  });

  accountEditedFeaturePromiseByOsmKey.set(osmKey, task);
  return task;
}

function buildEditedPointsGeoJson(keys) {
  const features = [];
  for (const osmKey of keys) {
    const center = accountEditedCenterByOsmKey.get(osmKey);
    if (!center) continue;
    const editId = Number(accountEditIdByOsmKey.get(osmKey) || 0);
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: center
      },
      properties: {
        osmKey,
        editId: editId > 0 ? editId : null
      }
    });
  }
  return { type: 'FeatureCollection', features };
}

function setEditedPointsSourceData(keys) {
  if (!accountMap) return;
  const source = accountMap.getSource(EDITED_POINTS_SOURCE_ID);
  if (!source) return;
  source.setData(buildEditedPointsGeoJson(keys));
}

function updateAccountMapModeByZoom() {
  if (!accountMap) return;
  const zoom = Number(accountMap.getZoom() || 0);
  const showPins = zoom < EDITS_CONTOUR_MIN_ZOOM;
  const pinVisibility = showPins ? 'visible' : 'none';

  if (accountMap.getLayer(EDITED_POINTS_CLUSTER_LAYER_ID)) {
    accountMap.setLayoutProperty(EDITED_POINTS_CLUSTER_LAYER_ID, 'visibility', pinVisibility);
  }
  if (accountMap.getLayer(EDITED_POINTS_CLUSTER_COUNT_LAYER_ID)) {
    accountMap.setLayoutProperty(EDITED_POINTS_CLUSTER_COUNT_LAYER_ID, 'visibility', pinVisibility);
  }
  if (accountMap.getLayer(EDITED_POINTS_UNCLUSTERED_LAYER_ID)) {
    accountMap.setLayoutProperty(EDITED_POINTS_UNCLUSTERED_LAYER_ID, 'visibility', pinVisibility);
  }
}

function bindAccountMapInteractionHandlers() {
  if (!accountMap || accountMapHandlersBound) return;
  accountMapHandlersBound = true;

  accountMap.on('click', EDITED_POINTS_CLUSTER_LAYER_ID, (event) => {
    const feature = event?.features?.[0];
    const clusterId = Number(feature?.properties?.cluster_id);
    if (!Number.isInteger(clusterId)) return;
    const source = accountMap.getSource(EDITED_POINTS_SOURCE_ID);
    if (!source || typeof source.getClusterExpansionZoom !== 'function') return;
    source.getClusterExpansionZoom(clusterId, (error, zoom) => {
      if (error) return;
      accountMap.easeTo({
        center: feature.geometry?.coordinates || accountMap.getCenter(),
        zoom,
        duration: 350
      });
    });
  });

  accountMap.on('click', EDITED_POINTS_UNCLUSTERED_LAYER_ID, async (event) => {
    const feature = event?.features?.[0];
    const osmKey = String(feature?.properties?.osmKey || '').trim();
    const editIdFromPoint = Number(feature?.properties?.editId || 0);
    const editId = editIdFromPoint > 0 ? editIdFromPoint : Number(accountEditIdByOsmKey.get(osmKey) || 0);
    if (editId > 0) await openEditDetails(String(editId));
  });

  const handleContourClick = async (event) => {
    const feature = event?.features?.[0];
    const osmKey = decodeOsmKeyFromEncodedFeatureId(feature?.id);
    if (!osmKey) return;
    const editId = Number(accountEditIdByOsmKey.get(osmKey) || 0);
    if (editId > 0) await openEditDetails(String(editId));
  };
  accountMap.on('click', 'edited-buildings-fill', handleContourClick);
  accountMap.on('click', 'edited-buildings-line', handleContourClick);

  const pointerLayers = [
    EDITED_POINTS_CLUSTER_LAYER_ID,
    EDITED_POINTS_UNCLUSTERED_LAYER_ID,
    'edited-buildings-fill',
    'edited-buildings-line'
  ];
  for (const layerId of pointerLayers) {
    accountMap.on('mouseenter', layerId, () => {
      accountMap.getCanvas().style.cursor = 'pointer';
    });
    accountMap.on('mouseleave', layerId, () => {
      accountMap.getCanvas().style.cursor = '';
    });
  }

  accountMap.on('zoomend', updateAccountMapModeByZoom);
}

async function ensureEditedPointsAndFit(keys) {
  const map = ensureAccountMap();
  if (!map) return;
  const seq = ++accountEditedPointsUpdateSeq;

  const missingKeys = keys.filter((key) => !accountEditedCenterByOsmKey.has(key));
  if (missingKeys.length > 0) {
    await Promise.all(missingKeys.map((key) => fetchBuildingFeatureByOsmKey(key)));
  }
  if (seq !== accountEditedPointsUpdateSeq) return;

  setEditedPointsSourceData(keys);
  const bounds = new window.maplibregl.LngLatBounds();
  let count = 0;
  for (const key of keys) {
    const center = accountEditedCenterByOsmKey.get(key);
    if (!center) continue;
    bounds.extend(center);
    count += 1;
  }
  if (count === 0 || bounds.isEmpty()) return;

  map.fitBounds(bounds, { padding: 60, duration: 450, maxZoom: 17 });
  const onMoveEnd = () => {
    map.off('moveend', onMoveEnd);
    updateAccountMapModeByZoom();
  };
  map.on('moveend', onMoveEnd);
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
  if (!accountMap.getSource(EDITED_POINTS_SOURCE_ID)) {
    accountMap.addSource(EDITED_POINTS_SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      cluster: true,
      clusterRadius: 44,
      clusterMaxZoom: 12
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
      paint: { 'fill-color': '#5B62F0', 'fill-opacity': 0.28 }
    });
  }
  if (!accountMap.getLayer('edited-buildings-line')) {
    accountMap.addLayer({
      id: 'edited-buildings-line',
      type: 'line',
      source: 'local-buildings',
      'source-layer': PMTILES_CONFIG.sourceLayer,
      minzoom: 13,
      paint: { 'line-color': '#5B62F0', 'line-width': 2.2 }
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
  if (!accountMap.getLayer(EDITED_POINTS_CLUSTER_LAYER_ID)) {
    accountMap.addLayer({
      id: EDITED_POINTS_CLUSTER_LAYER_ID,
      type: 'circle',
      source: EDITED_POINTS_SOURCE_ID,
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#5B62F0',
        'circle-radius': ['step', ['get', 'point_count'], 14, 20, 18, 80, 23],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff'
      }
    });
  }
  if (!accountMap.getLayer(EDITED_POINTS_CLUSTER_COUNT_LAYER_ID)) {
    accountMap.addLayer({
      id: EDITED_POINTS_CLUSTER_COUNT_LAYER_ID,
      type: 'symbol',
      source: EDITED_POINTS_SOURCE_ID,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-size': 12,
        'text-font': ['Open Sans Bold']
      },
      paint: {
        'text-color': '#ffffff'
      }
    });
  }
  if (!accountMap.getLayer(EDITED_POINTS_UNCLUSTERED_LAYER_ID)) {
    accountMap.addLayer({
      id: EDITED_POINTS_UNCLUSTERED_LAYER_ID,
      type: 'circle',
      source: EDITED_POINTS_SOURCE_ID,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': '#5B62F0',
        'circle-radius': 7,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff'
      }
    });
  }
  setEditedPointsSourceData([...highlightedEditKeys]);
  updateAccountMapModeByZoom();
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
  bindAccountMapInteractionHandlers();
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
    accountMap.setFilter('edited-buildings-fill', keyMatchExpr);
  }
  if (accountMap.getLayer('edited-buildings-line')) {
    accountMap.setFilter('edited-buildings-line', keyMatchExpr);
  }
  updateAccountMapModeByZoom();
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
  accountEditIdByOsmKey.clear();
  accountEditIdByOsmKey.set(editKey, editId);
  highlightedEditKeys = new Set([editKey]);
  applyEditedBuildingsPaint();
  setEditedPointsSourceData([editKey]);
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
  applyAccountStaticTexts();
  applyLegalSectionTexts();
  if (typeof panelPageUtils.initThemeToggle === 'function') {
    panelPageUtils.initThemeToggle({
      themeToggleEl,
      onThemeChange: applyTheme
    });
  }
  if (typeof panelPageUtils.initNavMenu === 'function') {
    panelPageUtils.initNavMenu({
      navMenuButtonEl,
      navMenuPanelEl
    });
  }
  if (typeof panelPageUtils.initMapReturnLinks === 'function') {
    panelPageUtils.initMapReturnLinks({
      navLogoLinkEl,
      mapReturnLinkEl,
      mapReturnMenuLinkEl
    });
  }
  await confirmRegistrationTokenIfPresent();
  await loadMe();
  await restoreFromUrl();
})();
