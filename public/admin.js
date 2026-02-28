let csrfToken = null;
let isMasterAdmin = false;
let currentAdminEmail = '';
let currentEditId = null;
let currentEditItem = null;
let allEditsCache = [];
let adminMap = null;
let highlightedEditKeys = new Set();

const adminState = {
  tab: 'users',
  q: '',
  role: '',
  canEdit: '',
  hasEdits: '',
  sortBy: 'createdAt',
  sortDir: 'desc',
  user: '',
  edit: '',
  editsQ: '',
  editsDate: '',
  editsUser: '',
  editsStatus: 'pending'
};

const I18N_RU = window.__ARCHIMAP_I18N_RU || {};
const UI_TEXT = Object.freeze(I18N_RU.ui || {});
const adminUsersUtils = window.ArchiMapAdminUsers || null;
const adminEditsUtils = window.ArchiMapAdminEdits || null;
const adminMapUtils = window.ArchiMapAdminMap || null;
const adminGuideUiKitUtils = window.ArchiMapAdminGuideUiKit || null;

const adminAppEl = document.getElementById('admin-app');
const adminLoadingEl = document.getElementById('admin-loading');
const subtitleEl = document.getElementById('admin-subtitle');
const navLogoLinkEl = document.getElementById('nav-logo-link');
const mapReturnLinkEl = document.getElementById('map-return-link');
const mapReturnMenuLinkEl = document.getElementById('map-return-menu-link');
const logoutBtnEl = document.getElementById('settings-logout-btn');
const settingsBuildLinkEl = document.getElementById('settings-build-link');
const settingsBuildTextEl = document.getElementById('settings-build-text');
const themeToggleEl = document.getElementById('theme-toggle');
const navMenuButtonEl = document.getElementById('nav-menu-button');
const navMenuPanelEl = document.getElementById('nav-menu-panel');
const tabUsersEl = document.getElementById('tab-users');
const tabEditsEl = document.getElementById('tab-edits');
const tabGuideEl = document.getElementById('tab-guide');
const tabUiKitEl = document.getElementById('tab-uikit');
const usersPanelEl = document.getElementById('users-panel');
const editsPanelEl = document.getElementById('edits-panel');
const guidePanelEl = document.getElementById('guide-panel');
const uiKitPanelEl = document.getElementById('uikit-panel');
const adminGuideTitleEl = document.getElementById('admin-guide-title');
const adminGuideSubtitleEl = document.getElementById('admin-guide-subtitle');
const adminGuideContentEl = document.getElementById('admin-guide-content');
const adminUiKitTitleEl = document.getElementById('admin-uikit-title');
const adminUiKitSubtitleEl = document.getElementById('admin-uikit-subtitle');
const adminUiBadgesTitleEl = document.getElementById('admin-ui-badges-title');
const adminUiBadgesEl = document.getElementById('admin-ui-badges');
const adminUiBadgesApiEl = document.getElementById('admin-ui-badges-api');
const adminUiTogglesTitleEl = document.getElementById('admin-ui-toggles-title');
const adminUiTogglesEl = document.getElementById('admin-ui-toggles');
const adminUiTogglesApiEl = document.getElementById('admin-ui-toggles-api');
const adminUiPanelTitleEl = document.getElementById('admin-ui-panel-title');
const adminUiPanelDemoEl = document.getElementById('admin-ui-panel-demo');
const adminUiPanelApiEl = document.getElementById('admin-ui-panel-api');
const adminUiHeaderTitleEl = document.getElementById('admin-ui-header-title');
const adminUiHeaderDemoEl = document.getElementById('admin-ui-header-demo');
const adminUiHeaderApiEl = document.getElementById('admin-ui-header-api');
const adminUiTabsTitleEl = document.getElementById('admin-ui-tabs-title');
const adminUiTabsDemoEl = document.getElementById('admin-ui-tabs-demo');
const adminUiTabsApiEl = document.getElementById('admin-ui-tabs-api');
const adminUiFieldsTitleEl = document.getElementById('admin-ui-fields-title');
const adminUiFieldsButtonsDemoEl = document.getElementById('admin-ui-fields-buttons-demo');
const adminUiFieldsApiEl = document.getElementById('admin-ui-fields-api');
const adminUiEmailsTitleEl = document.getElementById('admin-ui-emails-title');
const adminUiEmailRefreshEl = document.getElementById('admin-ui-email-refresh');
const adminUiEmailStatusEl = document.getElementById('admin-ui-email-status');
const adminUiEmailPreviewsEl = document.getElementById('admin-ui-email-previews');
const adminUiGuideTitleEl = document.getElementById('admin-ui-guide-title');
const adminUiGuideItem1El = document.getElementById('admin-ui-guide-item-1');
const adminUiGuideItem2El = document.getElementById('admin-ui-guide-item-2');
const adminUiGuideItem3El = document.getElementById('admin-ui-guide-item-3');
const adminUiGuideItem4El = document.getElementById('admin-ui-guide-item-4');
const usersSearchEl = document.getElementById('users-search');
const usersRoleFilterEl = document.getElementById('users-role-filter');
const usersCanEditFilterEl = document.getElementById('users-can-edit-filter');
const usersHasEditsFilterEl = document.getElementById('users-has-edits-filter');
const usersSortByEl = document.getElementById('users-sort-by');
const usersSortDirEl = document.getElementById('users-sort-dir');
const usersRefreshEl = document.getElementById('users-refresh');
const usersStatusEl = document.getElementById('users-status');
const usersListEl = document.getElementById('users-list');
const editsSearchEl = document.getElementById('edits-search');
const editsDateFilterEl = document.getElementById('edits-date-filter');
const editsUserFilterEl = document.getElementById('edits-user-filter');
const editsStatusFilterEl = document.getElementById('edits-status-filter');
const editsStatusEl = document.getElementById('edits-status');
const editsListEl = document.getElementById('edits-list');
const adminMapEl = document.getElementById('admin-map');
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
let uiKitInitialized = false;

const nativeFetch = window.fetch.bind(window);

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

function getLoginRedirectUrl() {
  return '/?auth=1&next=' + encodeURIComponent('/admin/');
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
  if (el) el.textContent = String(text || '');
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
  applyAdminMapTheme(next);
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
    [usersSearchEl, usersRoleFilterEl, usersCanEditFilterEl, usersSortByEl, editsSearchEl, editsDateFilterEl, editsUserFilterEl].forEach((el) => {
      if (el) el.className = ui.fieldClass('input');
    });
  }
  if (typeof ui.buttonClass === 'function') {
    if (usersRefreshEl) usersRefreshEl.className = ui.buttonClass('secondary');
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

function setAppVisibility(visible) {
  if (adminAppEl) adminAppEl.classList.toggle('hidden', !visible);
  if (adminLoadingEl) adminLoadingEl.classList.toggle('hidden', visible);
}

function readStateFromUrl() {
  try {
    const url = new URL(window.location.href);
    return {
      tab: String(url.searchParams.get('tab') || '').trim(),
      user: String(url.searchParams.get('user') || '').trim().toLowerCase(),
      edit: String(url.searchParams.get('edit') || '').trim(),
      q: String(url.searchParams.get('q') || '').trim(),
      role: String(url.searchParams.get('role') || '').trim(),
      canEdit: String(url.searchParams.get('canEdit') || '').trim(),
      hasEdits: String(url.searchParams.get('hasEdits') || '').trim(),
      sortBy: String(url.searchParams.get('sortBy') || '').trim(),
      sortDir: String(url.searchParams.get('sortDir') || '').trim(),
      editsQ: String(url.searchParams.get('editsQ') || '').trim(),
      editsDate: String(url.searchParams.get('editsDate') || '').trim(),
      editsUser: String(url.searchParams.get('editsUser') || '').trim().toLowerCase(),
      editsStatus: String(url.searchParams.get('editsStatus') || '').trim().toLowerCase()
    };
  } catch {
    return {};
  }
}

function writeStateToUrl(options = {}) {
  const replace = Boolean(options.replace);
  const url = new URL(window.location.href);
  const setOrDelete = (key, value) => {
    const val = String(value || '').trim();
    if (!val) {
      url.searchParams.delete(key);
      return;
    }
    url.searchParams.set(key, val);
  };

  setOrDelete('tab', adminState.tab);
  setOrDelete('user', adminState.user);
  setOrDelete('edit', adminState.edit);
  setOrDelete('q', adminState.q);
  setOrDelete('role', adminState.role);
  setOrDelete('canEdit', adminState.canEdit);
  setOrDelete('hasEdits', adminState.hasEdits);
  setOrDelete('sortBy', adminState.sortBy);
  setOrDelete('sortDir', adminState.sortDir);
  setOrDelete('editsQ', adminState.editsQ);
  setOrDelete('editsDate', adminState.editsDate);
  setOrDelete('editsUser', adminState.editsUser);
  setOrDelete('editsStatus', adminState.editsStatus);

  if (replace) {
    history.replaceState(null, '', url.toString());
  } else {
    history.pushState(null, '', url.toString());
  }
}

function applyStateToControls() {
  if (usersSearchEl) usersSearchEl.value = adminState.q;
  if (usersRoleFilterEl) usersRoleFilterEl.value = adminState.role;
  if (usersCanEditFilterEl) usersCanEditFilterEl.value = adminState.canEdit;
  if (usersHasEditsFilterEl) usersHasEditsFilterEl.value = adminState.hasEdits;
  if (usersSortByEl) usersSortByEl.value = adminState.sortBy;
  if (usersSortDirEl) usersSortDirEl.value = adminState.sortDir;
  if (editsSearchEl) editsSearchEl.value = adminState.editsQ;
  if (editsDateFilterEl) editsDateFilterEl.value = adminState.editsDate;
  if (editsUserFilterEl) editsUserFilterEl.value = adminState.editsUser;
  if (editsStatusFilterEl) editsStatusFilterEl.value = adminState.editsStatus || 'pending';
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
  adminState.tab = nextTab === 'edits'
    ? 'edits'
    : (nextTab === 'guide' ? 'guide' : (nextTab === 'uikit' ? 'uikit' : 'users'));
  const push = options.push !== false;

  if (usersPanelEl) usersPanelEl.classList.toggle('hidden', adminState.tab !== 'users');
  if (editsPanelEl) editsPanelEl.classList.toggle('hidden', adminState.tab !== 'edits');
  if (guidePanelEl) guidePanelEl.classList.toggle('hidden', adminState.tab !== 'guide');
  if (uiKitPanelEl) uiKitPanelEl.classList.toggle('hidden', adminState.tab !== 'uikit');

  setTabButtonState(tabUsersEl, adminState.tab === 'users');
  setTabButtonState(tabEditsEl, adminState.tab === 'edits');
  setTabButtonState(tabGuideEl, adminState.tab === 'guide');
  setTabButtonState(tabUiKitEl, adminState.tab === 'uikit');

  if (adminState.tab === 'edits') {
    const map = ensureAdminMap();
    if (map) {
      setTimeout(() => map.resize(), 0);
      applyEditedBuildingsPaint();
    }
  }
  if (adminState.tab === 'uikit') {
    renderAdminUiKit();
  }

  if (push) writeStateToUrl();
}

function renderAdminGuide() {
  if (!adminGuideContentEl) return;
  if (tabGuideEl) setText(tabGuideEl, t('adminTabGuide', null, 'Регламент правок'));
  if (adminGuideTitleEl) setText(adminGuideTitleEl, t('adminGuideTitle', null, 'Регламент обработки правок'));
  if (adminGuideSubtitleEl) setText(adminGuideSubtitleEl, t('adminGuideSubtitle', null, 'Как работает модерация, конфликтные ситуации и статусы.'));
  const flowItems = [
    t('adminGuideFlow1', null, 'Пользователь создает или обновляет pending-правку по зданию.'),
    t('adminGuideFlow2', null, 'Для одного пользователя и здания сохраняется только одна активная pending-правка.'),
    t('adminGuideFlow3', null, 'Админ выбирает решение по каждому тегу: принять или отклонить, с возможностью отредактировать значение.'),
    t('adminGuideFlow4', null, '"Принять все/Отклонить все" только выставляют решения по тегам, а не применяют их сразу.'),
    t('adminGuideFlow5', null, 'Изменения применяются только после кнопки "Применить решения".')
  ];
  const cornerCards = [
    {
      title: t('adminGuideCorner1Title', null, 'Параллельная модерация двумя администраторами'),
      text: t('adminGuideCorner1', null, 'Если два администратора одновременно применяют решение по одной правке, запись изменяется только при status=pending. Второй запрос получает 409 и не перезаписывает результат первого.'),
      badges: [
        '<span class="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">' + escapeHtml(t('editStatusPending', null, 'На рассмотрении')) + '</span>',
        '<span class="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">HTTP 409</span>'
      ].join('')
    },
    {
      title: t('adminGuideCorner2Title', null, 'Устаревшая правка (конфликт ревизии)'),
      text: t('adminGuideCorner2', null, 'Если локальная запись здания изменилась после создания пользовательской правки, merge блокируется с кодом EDIT_OUTDATED. Админу нужно открыть актуальные данные и повторно принять решение.'),
      badges: [
        '<span class="rounded-md bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-700">EDIT_OUTDATED</span>',
        '<span class="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">HTTP 409</span>'
      ].join('')
    },
    {
      title: t('adminGuideCorner3Title', null, 'Повторные правки одного пользователя по тому же зданию'),
      text: t('adminGuideCorner3', null, 'Для одного пользователя и здания поддерживается только одна активная pending-правка. Лишние pending автоматически помечаются как superseded, чтобы в модерации не было дублей.'),
      badges: [
        '<span class="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">' + escapeHtml(t('editStatusPending', null, 'На рассмотрении')) + '</span>',
        '<span class="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">' + escapeHtml(t('editStatusSuperseded', null, 'Заменено новой правкой')) + '</span>'
      ].join('')
    },
    {
      title: t('adminGuideCorner4Title', null, 'Частичное принятие тегов'),
      text: t('adminGuideCorner4', null, 'Если принята только часть тегов, правка получает статус partially_accepted. Принятые поля попадают в merged_fields_json, отклоненные остаются в комментарии для прозрачной истории.'),
      badges: [
        '<span class="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">' + escapeHtml(t('editStatusPartiallyAccepted', null, 'Частично принято')) + '</span>',
        '<span class="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">merged_fields_json</span>'
      ].join('')
    }
  ];

  adminGuideContentEl.innerHTML = `
    <div class="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <p class="text-sm font-semibold text-slate-900">${escapeHtml(t('adminGuideStatusesTitle', null, 'Статусы правок и их смысл'))}</p>
      <div class="mt-2 flex flex-wrap gap-2">
        <span class="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">${escapeHtml(t('editStatusPending', null, 'На рассмотрении'))}</span>
        <span class="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">${escapeHtml(t('editStatusAccepted', null, 'Принято'))}</span>
        <span class="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">${escapeHtml(t('editStatusPartiallyAccepted', null, 'Частично принято'))}</span>
        <span class="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-700">${escapeHtml(t('editStatusRejected', null, 'Отклонено'))}</span>
        <span class="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">${escapeHtml(t('editStatusSuperseded', null, 'Заменено новой правкой'))}</span>
      </div>
    </div>

    <div class="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <p class="text-sm font-semibold text-slate-900">${escapeHtml(t('adminGuideFlowTitle', null, 'Пошаговый workflow'))}</p>
      <div class="mt-2 grid gap-2">
        ${flowItems.map((line) => `<p class="rounded-lg border border-slate-200 bg-white px-3 py-2">${escapeHtml(line)}</p>`).join('')}
      </div>
    </div>

    <div class="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <p class="text-sm font-semibold text-slate-900">${escapeHtml(t('adminGuideExampleTitle', null, 'Пример: частичное принятие'))}</p>
      <p class="mt-2 text-sm text-slate-700">${escapeHtml(t('adminGuideExampleText', null, 'Здание way/22891444: из 5 изменений админ принял 3 и отклонил 2. Статус правки станет "Частично принято". В комментарий автоматически добавится список отклоненных тегов.'))}</p>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <span class="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">${escapeHtml(t('editCountersTotal', { count: 5 }, '5 всего'))}</span>
        <span class="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-600">${escapeHtml(t('editCountersCreated', { count: 2 }, '+2 создано'))}</span>
        <span class="rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-600">${escapeHtml(t('editCountersModified', { count: 3 }, '~3 изменено'))}</span>
        <span class="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">${escapeHtml(t('editStatusPartiallyAccepted', null, 'Частично принято'))}</span>
      </div>
    </div>

    <div class="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <p class="text-sm font-semibold text-slate-900">${escapeHtml(t('adminGuideCornerTitle', null, 'Corner cases и защита от ошибок'))}</p>
      <div class="mt-2 grid gap-2">
        ${cornerCards.map((card) => `
          <div class="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <p class="text-sm font-semibold text-slate-900">${escapeHtml(card.title)}</p>
            <p class="mt-1 text-sm text-slate-700">${escapeHtml(card.text)}</p>
            <div class="mt-2 flex flex-wrap gap-2">${card.badges}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderUiEmailCard(title, template) {
  if (adminGuideUiKitUtils?.renderUiEmailCard) {
    return adminGuideUiKitUtils.renderUiEmailCard(title, template, { t, escapeHtml });
  }
  const subject = String(template?.subject || '');
  const html = String(template?.html || '');
  const text = String(template?.text || '');
  return [
    '<article class="rounded-2xl border border-slate-200 bg-white p-3">',
    '<h3 class="text-sm font-semibold text-slate-900">' + escapeHtml(title) + '</h3>',
    '<p class="mt-1 text-xs text-slate-500">' + escapeHtml(t('uiEmailSubject', { value: subject }, 'Subject: {value}')) + '</p>',
    '<div class="mt-3 grid gap-3 xl:grid-cols-2">',
    '<div class="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">',
    '<p class="border-b border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600">' + escapeHtml(t('uiEmailHtml', null, 'HTML')) + '</p>',
    '<iframe class="h-[420px] w-full bg-white" sandbox="" referrerpolicy="no-referrer" srcdoc="' + escapeHtml(html) + '"></iframe>',
    '</div>',
    '<div class="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">',
    '<p class="border-b border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600">' + escapeHtml(t('uiEmailText', null, 'Text')) + '</p>',
    '<pre class="m-0 h-[420px] overflow-auto whitespace-pre-wrap break-words p-3 text-xs leading-5 text-slate-700">' + escapeHtml(text) + '</pre>',
    '</div>',
    '</div>',
    '</article>'
  ].join('');
}

async function loadAdminUiEmailPreviews() {
  if (!adminUiEmailStatusEl || !adminUiEmailPreviewsEl) return;
  adminUiEmailStatusEl.textContent = t('uiLoading', null, 'Загрузка...');
  adminUiEmailPreviewsEl.innerHTML = '';
  let resp;
  try {
    resp = await fetch('/api/ui/email-previews');
  } catch {
    adminUiEmailStatusEl.textContent = t('uiEmailLoadNetworkError', null, 'Ошибка сети при загрузке email шаблонов');
    return;
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.templates) {
    adminUiEmailStatusEl.textContent = String(data?.error || t('uiEmailLoadFailed', null, 'Не удалось загрузить email шаблоны'));
    return;
  }
  const registration = renderUiEmailCard(t('uiEmailRegistrationTitle', null, 'Письмо: подтверждение регистрации'), data.templates.registration);
  const passwordReset = renderUiEmailCard(t('uiEmailResetTitle', null, 'Письмо: сброс пароля'), data.templates.passwordReset);
  adminUiEmailPreviewsEl.innerHTML = registration + passwordReset;
  adminUiEmailStatusEl.textContent = t('uiUpdatedAt', { value: new Date().toLocaleString() }, 'Обновлено: {value}');
}

function renderAdminUiKit() {
  if (uiKitInitialized) return;
  const ui = getUI();
  if (!ui) return;
  if (tabUiKitEl) setText(tabUiKitEl, t('navUiKit', null, 'UI kit'));

  setText(adminUiKitTitleEl, t('uiReadmeTitle', null, 'UI README'));
  if (adminUiKitSubtitleEl) adminUiKitSubtitleEl.innerHTML = t('uiReadmeSubtitleHtml', null, 'Единая библиотека компонентов: <code>public/shared/ui.js</code>. Используйте её для общих шаблонов и классов.');
  setText(adminUiBadgesTitleEl, t('uiSectionBadges', null, 'Бейджи'));
  if (adminUiBadgesApiEl) adminUiBadgesApiEl.innerHTML = t('uiBadgesApiHtml', null, 'API: <code>ArchiMapUI.badge(text, variant)</code>');
  setText(adminUiTogglesTitleEl, t('uiSectionToggles', null, 'Рычажки'));
  if (adminUiTogglesApiEl) adminUiTogglesApiEl.innerHTML = t('uiTogglesApiHtml', null, 'API: <code>ArchiMapUI.renderToggle({...})</code>, поддержка <code>withIcons</code>, <code>kind</code>, <code>checkedColorClass</code>, <code>checkedKnobClass</code>, <code>checkedIconClass</code>.');
  setText(adminUiPanelTitleEl, t('uiSectionPanel', null, 'Панель'));
  if (adminUiPanelApiEl) adminUiPanelApiEl.innerHTML = t('uiPanelApiHtml', null, 'API: <code>ArchiMapUI.panel(content, options)</code>');
  setText(adminUiHeaderTitleEl, t('uiSectionHeader', null, 'Section Header'));
  if (adminUiHeaderApiEl) adminUiHeaderApiEl.innerHTML = t('uiHeaderApiHtml', null, 'API: <code>ArchiMapUI.sectionHeader(title, subtitle)</code>');
  setText(adminUiTabsTitleEl, t('uiSectionTabs', null, 'Вкладки'));
  if (adminUiTabsApiEl) adminUiTabsApiEl.innerHTML = t('uiTabsApiHtml', null, 'API: <code>ArchiMapUI.tabButtonClass(active)</code>');
  setText(adminUiFieldsTitleEl, t('uiSectionFields', null, 'Поля и кнопки'));
  if (adminUiFieldsApiEl) adminUiFieldsApiEl.innerHTML = t('uiFieldsApiHtml', null, 'API: <code>ArchiMapUI.fieldClass(kind)</code>, <code>ArchiMapUI.buttonClass(variant)</code>');
  setText(adminUiEmailsTitleEl, t('uiSectionEmails', null, 'Email шаблоны (preview)'));
  setText(adminUiEmailRefreshEl, t('uiRefresh', null, 'Обновить'));
  setText(adminUiEmailStatusEl, t('uiLoading', null, 'Загрузка...'));
  setText(adminUiGuideTitleEl, t('uiGuideTitle', null, 'Инструкция по использованию'));
  if (adminUiGuideItem1El) adminUiGuideItem1El.innerHTML = t('uiGuideItem1Html', null, 'Подключай <code>/shared/ui.js</code> перед любыми шаблонами/страницами.');
  if (adminUiGuideItem2El) adminUiGuideItem2El.innerHTML = t('uiGuideItem2Html', null, 'Для навигации подключай <code>/shared/top-nav.js</code> и рендери <code>ArchiMapTopNav.render({ context })</code>.');
  if (adminUiGuideItem3El) adminUiGuideItem3El.innerHTML = t('uiGuideItem3Html', null, 'Новые общие UI-элементы сначала добавляй в <code>ui.js</code>, потом используй в страницах.');
  if (adminUiGuideItem4El) adminUiGuideItem4El.innerHTML = t('uiGuideItem4Html', null, 'Дублирующиеся классы в HTML постепенно заменяй на шаблоны из <code>ArchiMapUI</code>.');

  if (adminUiBadgesEl) {
    adminUiBadgesEl.innerHTML = [
      ui.badge('neutral', 'neutral'),
      ui.badge('success', 'success'),
      ui.badge('info', 'info'),
      ui.badge('brand', 'brand'),
      ui.badge('warning', 'warning'),
      ui.badge('danger', 'danger')
    ].join('');
  }
  if (adminUiTogglesEl) {
    adminUiTogglesEl.innerHTML = [
      ui.renderToggle({ id: 'admin-demo-theme', ariaLabel: 'theme', withIcons: true, kind: 'theme', checkedColorClass: 'peer-checked:bg-brand-purple', checkedKnobClass: 'peer-checked:bg-violet-50', checkedIconClass: 'peer-checked:text-white' }),
      ui.renderToggle({ id: 'admin-demo-labels', ariaLabel: 'labels', withIcons: true, kind: 'labels', checkedColorClass: 'peer-checked:bg-indigo-500', checkedKnobClass: 'peer-checked:bg-indigo-50', checkedIconClass: 'peer-checked:text-indigo-700' })
    ].join('');
  }
  if (adminUiPanelDemoEl) {
    adminUiPanelDemoEl.innerHTML = ui.panel(`<p class="text-sm text-slate-700">${escapeHtml(t('uiPanelDemoText', null, 'Контент внутри стандартизованной панели.'))}</p>`, { className: 'rounded-2xl border border-slate-200 bg-white p-4' });
  }
  if (adminUiHeaderDemoEl) {
    adminUiHeaderDemoEl.innerHTML = ui.sectionHeader(t('uiHeaderDemoTitle', null, 'Заголовок секции'), t('uiHeaderDemoSubtitle', null, 'Подзаголовок и описание в одном стиле'));
  }
  if (adminUiTabsDemoEl) {
    adminUiTabsDemoEl.innerHTML = [
      '<div class="flex gap-2">',
      '<button type="button" class="' + ui.tabButtonClass(true) + '">' + escapeHtml(t('uiTabActive', null, 'Активная')) + '</button>',
      '<button type="button" class="' + ui.tabButtonClass(false) + '">' + escapeHtml(t('uiTabInactive', null, 'Неактивная')) + '</button>',
      '</div>'
    ].join('');
  }
  if (adminUiFieldsButtonsDemoEl) {
    adminUiFieldsButtonsDemoEl.innerHTML = [
      '<input type="text" class="' + ui.fieldClass('input') + '" placeholder="' + escapeHtml(t('uiInputPlaceholder', null, 'Текстовое поле')) + '" />',
      '<select class="' + ui.fieldClass('select') + '"><option>' + escapeHtml(t('uiSelectPlaceholder', null, 'Селект')) + '</option></select>',
      '<div class="flex flex-wrap gap-2">',
      '<button type="button" class="' + ui.buttonClass('primary') + '">Primary</button>',
      '<button type="button" class="' + ui.buttonClass('outlineBrand') + '">Outline Brand</button>',
      '<button type="button" class="' + ui.buttonClass('secondary') + '">Secondary</button>',
      '</div>'
    ].join('');
  }

  if (adminUiEmailRefreshEl) adminUiEmailRefreshEl.addEventListener('click', loadAdminUiEmailPreviews);
  loadAdminUiEmailPreviews();
  uiKitInitialized = true;
}

function collectUsersFiltersFromControls() {
  adminState.q = String(usersSearchEl?.value || '').trim();
  adminState.role = String(usersRoleFilterEl?.value || '').trim();
  adminState.canEdit = String(usersCanEditFilterEl?.value || '').trim();
  adminState.hasEdits = String(usersHasEditsFilterEl?.value || '').trim();
  adminState.sortBy = String(usersSortByEl?.value || 'createdAt').trim();
  adminState.sortDir = String(usersSortDirEl?.value || 'desc').trim();
}

function collectEditsFiltersFromControls() {
  adminState.editsQ = String(editsSearchEl?.value || '').trim();
  adminState.editsDate = String(editsDateFilterEl?.value || '').trim();
  adminState.editsUser = String(editsUserFilterEl?.value || '').trim().toLowerCase();
  adminState.editsStatus = String(editsStatusFilterEl?.value || 'pending').trim().toLowerCase() || 'pending';
}

function buildUsersQuery() {
  const url = new URL('/api/admin/users', window.location.origin);
  const pairs = [
    ['q', adminState.q],
    ['role', adminState.role],
    ['canEdit', adminState.canEdit],
    ['hasEdits', adminState.hasEdits],
    ['sortBy', adminState.sortBy],
    ['sortDir', adminState.sortDir]
  ];
  for (const [key, value] of pairs) {
    if (String(value || '').trim()) url.searchParams.set(key, String(value).trim());
  }
  return `${url.pathname}${url.search}`;
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
  isMasterAdmin = Boolean(user.isMasterAdmin);
  currentAdminEmail = String(user.email || '').trim().toLowerCase();

  if (!user.isAdmin) {
    setText(subtitleEl, t('adminAccessDenied', null, 'Доступ запрещен: нужны права администратора'));
    if (usersPanelEl) usersPanelEl.classList.add('hidden');
    if (editsPanelEl) editsPanelEl.classList.add('hidden');
    return null;
  }

  setText(subtitleEl, String(user.email || user.username || 'admin'));
  return user;
}

function renderUserRows(items) {
  if (!usersListEl) return;
  const ui = getUI();
  const renderBadge = (text, variant, fallbackClass) => {
    if (ui && typeof ui.badge === 'function') return ui.badge(text, variant);
    return `<span class="rounded-full px-2.5 py-1 text-xs font-medium ${fallbackClass}">${escapeHtml(text)}</span>`;
  };
  if (!Array.isArray(items) || items.length === 0) {
    usersListEl.innerHTML = `<tr><td colspan="5" class="px-4 py-6 text-center text-sm text-slate-600">${escapeHtml(t('adminUsersEmpty', null, 'Пользователи не найдены.'))}</td></tr>`;
    return;
  }

  usersListEl.innerHTML = items.map((item) => {
    const model = adminUsersUtils?.buildUserViewModel
      ? adminUsersUtils.buildUserViewModel(item, currentAdminEmail)
      : null;
    const email = String(model?.email || item?.email || '').trim().toLowerCase();
    const displayName = String(model?.displayName || email);
    const isAdmin = Boolean(model?.isAdmin ?? item?.isAdmin);
    const isMasterAdminAccount = Boolean(model?.isMasterAdminAccount ?? item?.isMasterAdmin);
    const isSelfMasterAdminDemotionLocked = Boolean(model?.isSelfMasterAdminDemotionLocked);
    const canEdit = Boolean(model?.canEdit ?? item?.canEdit);
    const editsCount = Number((model?.editsCount ?? item?.editsCount) || 0);
    const createdAt = String(model?.createdAt || item?.createdAt || '').replace('T', ' ').replace('Z', '');

    return `
      <tr class="border-t border-slate-200 hover:bg-slate-50">
        <td class="px-4 py-3">
          <p class="font-semibold text-slate-900">${escapeHtml(displayName)}</p>
          <p class="text-xs text-slate-500">${escapeHtml(email)}</p>
        </td>
        <td class="px-4 py-3 text-slate-600">${escapeHtml(createdAt || '-')}</td>
        <td class="px-4 py-3">
          ${isMasterAdminAccount ? `<span class="mr-1">${renderBadge(t('adminRoleBadgeMasterAdmin', null, 'Мастер-админ'), 'warning', 'bg-amber-100 text-amber-700')}</span>` : ''}
          <span class="mr-1">${renderBadge(isAdmin ? t('adminRoleBadgeAdmin', null, 'Админ') : t('adminRoleBadgeUser', null, 'Пользователь'), isAdmin ? 'brand' : 'neutral', isAdmin ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-700')}</span>
          ${renderBadge(canEdit ? t('adminPermCanEdit', null, 'Может редактировать') : t('adminPermReadOnly', null, 'Только просмотр'), canEdit ? 'success' : 'neutral', canEdit ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-700')}
        </td>
        <td class="px-4 py-3">
          <button data-action="open-user-edits" data-email="${escapeHtml(email)}" class="font-semibold text-brand-purple underline underline-offset-2 hover:text-indigo-700">${editsCount}</button>
        </td>
        <td class="px-4 py-3 text-right">
          <div class="inline-flex gap-1">
            <button data-action="toggle-edit" data-email="${escapeHtml(email)}" data-can-edit="${canEdit ? '1' : '0'}" class="rounded-[12px] border px-2 py-1 text-xs ${canEdit ? 'border-emerald-300 text-emerald-700' : 'border-slate-300 text-slate-700'}">${canEdit ? escapeHtml(t('adminToggleEditOn', null, 'Запретить')) : escapeHtml(t('adminToggleEditOff', null, 'Разрешить'))}</button>
            <button
              data-action="toggle-admin"
              data-email="${escapeHtml(email)}"
              data-is-admin="${isAdmin ? '1' : '0'}"
              data-role-locked="${isSelfMasterAdminDemotionLocked ? '1' : '0'}"
              title="${isSelfMasterAdminDemotionLocked ? escapeHtml(t('adminMasterAdminRoleLocked', null, 'Мастер-админ не может снять с себя роль admin')) : ''}"
              ${isSelfMasterAdminDemotionLocked ? 'disabled aria-disabled="true"' : ''}
              class="rounded-[12px] border px-2 py-1 text-xs ${isAdmin ? 'border-violet-300 text-violet-700' : 'border-slate-300 text-slate-700'} ${isSelfMasterAdminDemotionLocked ? 'cursor-not-allowed border-slate-200 text-slate-400' : ''} ${isMasterAdmin ? '' : 'hidden'}"
            >${isAdmin ? escapeHtml(t('adminToggleRoleOn', null, 'Снять admin')) : escapeHtml(t('adminToggleRoleOff', null, 'Сделать admin'))}</button>
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
  if (adminEditsUtils?.getChangeCounters) {
    return adminEditsUtils.getChangeCounters(changes);
  }
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

function renderEditStatusBadge(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'accepted') {
    return `<span class="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">${escapeHtml(t('editStatusAccepted', null, 'Принято'))}</span>`;
  }
  if (normalized === 'partially_accepted') {
    return `<span class="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">${escapeHtml(t('editStatusPartiallyAccepted', null, 'Частично принято'))}</span>`;
  }
  if (normalized === 'rejected') {
    return `<span class="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-700">${escapeHtml(t('editStatusRejected', null, 'Отклонено'))}</span>`;
  }
  if (normalized === 'superseded') {
    return `<span class="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">${escapeHtml(t('editStatusSuperseded', null, 'Заменено новой правкой'))}</span>`;
  }
  return `<span class="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">${escapeHtml(t('editStatusPending', null, 'На рассмотрении'))}</span>`;
}

function renderEditsRows(items) {
  if (!editsListEl) return;
  if (!Array.isArray(items) || items.length === 0) {
    editsListEl.innerHTML = `<tr><td colspan="4" class="px-4 py-6 text-center text-sm text-slate-600">${escapeHtml(t('adminEditsEmpty', null, 'Локальных правок нет.'))}</td></tr>`;
    return;
  }

  editsListEl.innerHTML = items.map((item) => {
    const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`;
    const editId = Number(item?.editId || 0);
    const address = getEditAddress(item);
    const author = String(item?.updatedBy || '-');
    const counters = getChangeCounters(item?.changes);

    return `
      <tr data-action="open-edit" data-edit-key="${escapeHtml(osmKey)}" data-edit-id="${escapeHtml(editId)}" class="cursor-pointer border-t border-slate-200 hover:bg-slate-50">
        <td class="px-4 py-3">
          <p class="font-semibold text-slate-900">${escapeHtml(address)}</p>
          <p class="text-xs text-slate-500">ID: ${escapeHtml(osmKey)}</p>
        </td>
        <td class="px-4 py-3">${escapeHtml(author)}</td>
        <td class="px-4 py-3">${renderEditStatusBadge(item?.status)}</td>
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

function populateEditsUserFilter(items) {
  if (!editsUserFilterEl) return;
  const selected = adminState.editsUser;
  const users = [...new Set((Array.isArray(items) ? items : []).map((item) => String(item?.updatedBy || '').trim().toLowerCase()).filter(Boolean))].sort();
  editsUserFilterEl.innerHTML = `<option value="">${escapeHtml(t('adminUserFilterAll', null, 'Пользователь: все'))}</option>` + users.map((user) => `<option value="${escapeHtml(user)}">${escapeHtml(user)}</option>`).join('');
  editsUserFilterEl.value = selected;
}

function syncMapHighlightsWithEdits(items) {
  highlightedEditKeys = new Set(
    (Array.isArray(items) ? items : []).map((item) => `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`)
  );
  applyEditedBuildingsPaint();
}

function applyEditsFilters() {
  const query = adminState.editsQ.toLowerCase();
  const date = adminState.editsDate;
  const user = adminState.editsUser;
  const status = String(adminState.editsStatus || 'pending').trim().toLowerCase();

  const filtered = allEditsCache.filter((item) => {
    const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`.toLowerCase();
    const address = getEditAddress(item).toLowerCase();
    const author = String(item?.updatedBy || '').trim().toLowerCase();
    const updatedAt = String(item?.updatedAt || '');

    if (query && !address.includes(query) && !osmKey.includes(query)) return false;
    if (date && !updatedAt.startsWith(date)) return false;
    if (user && author !== user) return false;
    if (status && status !== 'all' && String(item?.status || '').trim().toLowerCase() !== status) return false;
    return true;
  });

  setText(editsStatusEl, t('editsShownSummary', { shown: filtered.length, total: allEditsCache.length }, `Показано: ${filtered.length} из ${allEditsCache.length}`));
  renderEditsRows(filtered);
  syncMapHighlightsWithEdits(filtered);
}

async function loadUsers(options = {}) {
  const silent = Boolean(options.silent);
  if (!silent) setText(usersStatusEl, t('adminUsersLoading', null, 'Загрузка...'));

  const url = buildUsersQuery();
  let resp;
  try {
    resp = await fetch(url);
  } catch {
    setText(usersStatusEl, t('adminUsersNetworkError', null, 'Ошибка сети'));
    return [];
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    setText(usersStatusEl, String(data?.error || t('adminUsersLoadFailed', null, 'Не удалось загрузить пользователей')));
    return [];
  }

  const items = Array.isArray(data.items) ? data.items : [];
  renderUserRows(items);
  setText(usersStatusEl, t('adminUsersFound', { count: items.length }, `Найдено: ${items.length}`));
  return items;
}

async function loadAllEdits() {
  setText(editsStatusEl, t('adminEditsLoading', null, 'Загрузка...'));
  let resp;
  try {
    resp = await fetch('/api/admin/building-edits?status=all');
  } catch {
    setText(editsStatusEl, t('adminEditsNetworkError', null, 'Ошибка сети'));
    return;
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    setText(editsStatusEl, String(data?.error || t('adminEditsLoadFailed', null, 'Не удалось загрузить правки')));
    return;
  }

  allEditsCache = Array.isArray(data.items) ? data.items : [];
  populateEditsUserFilter(allEditsCache);
  applyEditsFilters();
}

function closeEditModal(options = {}) {
  const push = options.push !== false;
  currentEditId = null;
  currentEditItem = null;
  adminState.edit = '';
  if (editDetailPaneEl) editDetailPaneEl.classList.add('hidden');
  if (adminAppEl) adminAppEl.classList.remove('edit-pane-open');
  if (push) writeStateToUrl();
}

function getMapStyleForTheme(theme) {
  return theme === 'dark' ? DARK_MAP_STYLE_URL : LIGHT_MAP_STYLE_URL;
}

function ensureAdminMapLayers() {
  if (!adminMap) return;
  if (!adminMap.getSource('local-buildings')) {
    const pmtilesUrl = PMTILES_CONFIG.url.startsWith('http')
      ? PMTILES_CONFIG.url
      : `${window.location.origin}${PMTILES_CONFIG.url.startsWith('/') ? '' : '/'}${PMTILES_CONFIG.url}`;
    adminMap.addSource('local-buildings', {
      type: 'vector',
      url: `pmtiles://${pmtilesUrl}`
    });
  }
  if (!adminMap.getSource('selected-building')) {
    adminMap.addSource('selected-building', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
  }
  if (!adminMap.getLayer('local-buildings-fill')) {
    adminMap.addLayer({
      id: 'local-buildings-fill',
      type: 'fill',
      source: 'local-buildings',
      'source-layer': PMTILES_CONFIG.sourceLayer,
      minzoom: 13,
      paint: {
        'fill-color': '#9ca3af',
        'fill-opacity': 0.35
      }
    });
  }
  if (!adminMap.getLayer('local-buildings-line')) {
    adminMap.addLayer({
      id: 'local-buildings-line',
      type: 'line',
      source: 'local-buildings',
      'source-layer': PMTILES_CONFIG.sourceLayer,
      minzoom: 13,
      paint: {
        'line-color': '#6b7280',
        'line-width': 0.8
      }
    });
  }
  if (!adminMap.getLayer('edited-buildings-fill')) {
    adminMap.addLayer({
      id: 'edited-buildings-fill',
      type: 'fill',
      source: 'local-buildings',
      'source-layer': PMTILES_CONFIG.sourceLayer,
      minzoom: 13,
      paint: {
        'fill-color': '#5B62F0',
        'fill-opacity': 0
      }
    });
  }
  if (!adminMap.getLayer('edited-buildings-line')) {
    adminMap.addLayer({
      id: 'edited-buildings-line',
      type: 'line',
      source: 'local-buildings',
      'source-layer': PMTILES_CONFIG.sourceLayer,
      minzoom: 13,
      paint: {
        'line-color': 'rgba(0,0,0,0)',
        'line-width': 0
      }
    });
  }
  if (!adminMap.getLayer('selected-building-fill')) {
    adminMap.addLayer({
      id: 'selected-building-fill',
      type: 'fill',
      source: 'selected-building',
      paint: {
        'fill-color': '#5B62F0',
        'fill-opacity': 0.24
      }
    });
  }
  if (!adminMap.getLayer('selected-building-line')) {
    adminMap.addLayer({
      id: 'selected-building-line',
      type: 'line',
      source: 'selected-building',
      paint: {
        'line-color': '#5B62F0',
        'line-width': 3
      }
    });
  }
  applyEditedBuildingsPaint();
}

function ensureAdminMap() {
  if (adminMap || !adminMapEl) return adminMap;
  if (typeof window.maplibregl === 'undefined' || typeof window.pmtiles === 'undefined') {
    adminMapEl.innerHTML = `<div class="flex h-full items-center justify-center text-sm text-slate-500">${escapeHtml(t('mapLibLoadFailed', null, 'MapLibre/PMTiles не загружены'))}</div>`;
    return null;
  }

  const protocol = new window.pmtiles.Protocol();
  window.maplibregl.addProtocol('pmtiles', protocol.tile);

  adminMap = new window.maplibregl.Map({
    container: adminMapEl,
    style: getMapStyleForTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'),
    center: [44.0059, 56.3269],
    zoom: 14
  });
  adminMap.addControl(new window.maplibregl.NavigationControl(), 'top-right');
  adminMap.on('style.load', () => {
    ensureAdminMapLayers();
    applyEditedBuildingsPaint();
  });
  adminMap.on('load', () => {
    ensureAdminMapLayers();
    applyEditedBuildingsPaint();
  });
  return adminMap;
}

function applyAdminMapTheme(theme) {
  if (!adminMap) return;
  adminMap.setStyle(getMapStyleForTheme(theme));
}

function extendBoundsFromCoords(bounds, coords) {
  if (adminMapUtils?.extendBoundsFromCoords) {
    adminMapUtils.extendBoundsFromCoords(bounds, coords);
    return;
  }
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    bounds.extend([coords[0], coords[1]]);
    return;
  }
  for (const value of coords) extendBoundsFromCoords(bounds, value);
}

function getEditedKeysExpression() {
  if (adminMapUtils?.getEditedKeysExpression) {
    return adminMapUtils.getEditedKeysExpression(highlightedEditKeys);
  }
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
  if (!adminMap) return;
  const keyMatchExpr = getEditedKeysExpression();
  if (adminMap.getLayer('edited-buildings-fill')) {
    adminMap.setPaintProperty('edited-buildings-fill', 'fill-opacity', [
      'case',
      keyMatchExpr,
      0.28,
      0
    ]);
  }
  if (adminMap.getLayer('edited-buildings-line')) {
    adminMap.setPaintProperty('edited-buildings-line', 'line-color', [
      'case',
      keyMatchExpr,
      '#5B62F0',
      'rgba(0,0,0,0)'
    ]);
    adminMap.setPaintProperty('edited-buildings-line', 'line-width', [
      'case',
      keyMatchExpr,
      2.2,
      0
    ]);
  }
}

async function updateDetailMapFeature(feature) {
  const map = ensureAdminMap();
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

  if (map.loaded()) {
    apply();
  } else {
    map.once('load', apply);
  }
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

function buildAdminReviewActions(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const status = String(item?.status || '').trim().toLowerCase();
  if (status !== 'pending') {
    return `
      <div class="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
        <div class="flex flex-wrap items-center gap-2">
          <span>${escapeHtml(t('adminReviewStatus', null, 'Статус правки:'))}</span>
          ${renderEditStatusBadge(status)}
        </div>
      </div>
    `;
  }
  const fieldRows = changes.map((change) => {
    const field = String(change?.field || '').trim();
    const value = change?.localValue == null ? '' : String(change.localValue);
    const oldValue = change?.osmValue == null ? t('diffEmptyValue', null, 'пусто') : String(change.osmValue);
    const newValue = change?.localValue == null ? t('diffEmptyValue', null, 'пусто') : String(change.localValue);
    const isNew = change?.osmValue == null && change?.localValue != null;
    const valueClass = isNew ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700';
    return `
      <div data-review-field="${escapeHtml(field)}" data-field-decision="accept" class="grid gap-2 rounded-lg border border-slate-200 bg-white p-2 text-sm">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-semibold text-slate-700">${escapeHtml(String(change?.label || field || '-'))}</span>
          <div class="inline-flex items-center gap-1">
            <button type="button" data-field-action="accept" data-field-name="${escapeHtml(field)}" class="review-field-btn rounded-[10px] border border-brand-purple bg-brand-purple px-2.5 py-1 text-xs font-semibold text-white">${escapeHtml(t('adminFieldAccept', null, 'Принять'))}</button>
            <button type="button" data-field-action="reject" data-field-name="${escapeHtml(field)}" class="review-field-btn rounded-[10px] border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700">${escapeHtml(t('adminFieldReject', null, 'Отклонить'))}</button>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="text-slate-500 line-through">${escapeHtml(oldValue)}</span>
          <span class="text-slate-400">-&gt;</span>
          <span class="rounded-md px-2 py-1 ${valueClass}">${escapeHtml(newValue)}</span>
        </div>
        <input type="text" data-merge-value="${escapeHtml(field)}" value="${escapeHtml(value)}" class="w-full rounded-[12px] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-purple focus:ring-brand-purple" />
      </div>
    `;
  }).join('');

  return `
    <div class="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <p class="text-sm font-semibold text-slate-900">${escapeHtml(t('adminReviewTitle', null, 'Модерация правки'))}</p>
      <div class="grid gap-2 pr-1">${fieldRows || `<p class="text-sm text-slate-600">${escapeHtml(t('adminNoDiffToMerge', null, 'Нет отличий для мерджа.'))}</p>`}</div>
      <textarea id="edit-admin-comment" rows="2" placeholder="${escapeHtml(t('adminCommentPlaceholder', null, 'Комментарий администратора (опционально)'))}" class="w-full rounded-[12px] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-purple focus:ring-brand-purple"></textarea>
      <div class="flex flex-wrap gap-2">
        <button id="edit-apply-decisions-btn" type="button" class="rounded-[12px] bg-brand-purple px-3 py-2 text-sm font-semibold text-white hover:brightness-110">${escapeHtml(t('adminApplyDecisions', null, 'Применить решения'))}</button>
        <button id="edit-merge-all-btn" type="button" class="rounded-[12px] border border-brand-purple bg-white px-3 py-2 text-sm font-semibold text-brand-purple hover:bg-indigo-50">${escapeHtml(t('adminMergeAll', null, 'Принять все'))}</button>
        <button id="edit-reject-btn" type="button" class="rounded-[12px] border border-rose-300 px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50">${escapeHtml(t('adminRejectAll', null, 'Отклонить все'))}</button>
      </div>
      <p id="edit-admin-status" class="text-sm text-slate-600"></p>
    </div>
  `;
}

function setReviewFieldDecision(field, decision) {
  const normalizedField = String(field || '').trim();
  const normalizedDecision = decision === 'reject' ? 'reject' : 'accept';
  if (!normalizedField) return;
  const row = [...document.querySelectorAll('[data-review-field]')]
    .find((node) => String(node.getAttribute('data-review-field') || '').trim() === normalizedField);
  if (!row) return;
  row.setAttribute('data-field-decision', normalizedDecision);
  const buttons = row.querySelectorAll('[data-field-action]');
  buttons.forEach((button) => {
    const action = String(button.getAttribute('data-field-action') || '').trim();
    const isActive = action === normalizedDecision;
    button.classList.remove('border-brand-purple', 'bg-brand-purple', 'text-white', 'border-rose-300', 'bg-rose-50', 'text-rose-700', 'border-slate-300', 'bg-white', 'text-slate-700');
    if (!isActive) {
      button.classList.add('border-slate-300', 'bg-white', 'text-slate-700');
      return;
    }
    if (action === 'reject') {
      button.classList.add('border-rose-300', 'bg-rose-50', 'text-rose-700');
      return;
    }
    button.classList.add('border-brand-purple', 'bg-brand-purple', 'text-white');
  });
}

function collectFieldDecisions() {
  const rows = [...document.querySelectorAll('[data-review-field]')];
  const accepted = [];
  const rejected = [];
  for (const row of rows) {
    const field = String(row.getAttribute('data-review-field') || '').trim();
    if (!field) continue;
    const decision = String(row.getAttribute('data-field-decision') || 'accept').trim().toLowerCase();
    if (decision === 'reject') {
      rejected.push(field);
    } else {
      accepted.push(field);
    }
  }
  return { accepted, rejected };
}

function setAllReviewFieldDecisions(decision) {
  const rows = [...document.querySelectorAll('[data-review-field]')];
  rows.forEach((row) => {
    const field = String(row.getAttribute('data-review-field') || '').trim();
    if (!field) return;
    setReviewFieldDecision(field, decision);
  });
}

function buildModerationComment(baseComment, rejectedFields) {
  const comment = String(baseComment || '').trim();
  if (!Array.isArray(rejectedFields) || rejectedFields.length === 0) return comment;
  const notePrefix = t('adminRejectedFieldsNote', null, 'Отклонены теги');
  const note = `${notePrefix}: ${rejectedFields.join(', ')}`;
  return comment ? `${comment}\n${note}` : note;
}

async function submitAdminModeration(action) {
  if (!currentEditId || !currentEditItem) return;
  const statusEl = document.getElementById('edit-admin-status');
  const commentEl = document.getElementById('edit-admin-comment');
  const comment = String(commentEl?.value || '').trim();
  if (statusEl) statusEl.textContent = t('adminActionSaving', null, 'Сохраняем...');

  let url = '';
  let body = {};
  const valueInputs = [...document.querySelectorAll('[data-merge-value]')];
  const valueByField = new Map();
  for (const input of valueInputs) {
    const key = String(input.getAttribute('data-merge-value') || '').trim();
    if (!key) continue;
    valueByField.set(key, String(input.value || '').trim());
  }
  if (action === 'merge') {
    const fields = [...valueByField.keys()];
    const values = Object.fromEntries(fields.map((field) => [field, valueByField.get(field)]));
    url = `/api/admin/building-edits/${encodeURIComponent(currentEditId)}/merge`;
    body = { fields, values, comment };
  } else if (action === 'apply') {
    const { accepted, rejected } = collectFieldDecisions();
    if (accepted.length === 0 && rejected.length === 0) {
      if (statusEl) statusEl.textContent = t('adminNoFieldDecisions', null, 'Нет выбранных полей');
      return;
    }
    if (accepted.length === 0) {
      url = `/api/admin/building-edits/${encodeURIComponent(currentEditId)}/reject`;
      body = { comment: buildModerationComment(comment, rejected) };
    } else {
      const values = Object.fromEntries(accepted.map((field) => [field, valueByField.get(field) || '']));
      url = `/api/admin/building-edits/${encodeURIComponent(currentEditId)}/merge`;
      body = {
        fields: accepted,
        values,
        comment: buildModerationComment(comment, rejected)
      };
    }
  } else {
    url = `/api/admin/building-edits/${encodeURIComponent(currentEditId)}/reject`;
    body = { comment };
  }

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    if (statusEl) statusEl.textContent = t('adminEditsNetworkError', null, 'Ошибка сети');
    return;
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (statusEl) statusEl.textContent = String(data?.error || t('adminActionFailed', null, 'Не удалось выполнить действие'));
    return;
  }
  if (statusEl) {
    if (action === 'merge') {
      statusEl.textContent = t('adminEditAccepted', null, 'Правка принята');
    } else if (action === 'apply') {
      statusEl.textContent = data?.status === 'rejected'
        ? t('adminEditRejected', null, 'Правка отклонена')
        : t('adminEditPartiallyAccepted', null, 'Решения по тегам применены');
    } else {
      statusEl.textContent = t('adminEditRejected', null, 'Правка отклонена');
    }
  }
  await loadAllEdits();
  await openEditDetails(String(currentEditId), { push: false });
}

async function openEditDetails(editIdRaw, options = {}) {
  const push = options.push !== false;
  const editId = parseEditId(editIdRaw);
  if (!editId) return;
  setTab('edits', { push: false });

  const url = `/api/admin/building-edits/${encodeURIComponent(editId)}`;
  let resp;
  try {
    resp = await fetch(url);
  } catch {
    return;
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.item) return;

  const item = data.item;
  const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`;
  currentEditId = Number(item?.editId || editId);
  currentEditItem = item;
  adminState.edit = String(currentEditId);
  if (push) writeStateToUrl();

  const address = getEditAddress(item);
  if (editDetailTitleEl) editDetailTitleEl.textContent = address;
  if (editDetailMetaEl) editDetailMetaEl.textContent = `${t('adminMetaAuthor', { author: String(item.updatedBy || '-') }, `Автор: ${String(item.updatedBy || '-')}`)} | ${t('adminMetaId', { id: osmKey }, `ID: ${osmKey}`)} | ${t('adminMetaStatus', { status: String(item.status || 'pending') }, `Статус: ${String(item.status || 'pending')}`)} | ${String(item.updatedAt || '-')}`;

  if (editDetailListEl) {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    if (String(item?.status || '').trim().toLowerCase() === 'pending') {
      editDetailListEl.innerHTML = buildAdminReviewActions(item);
    } else {
      const listHtml = changes.length === 0
        ? `<p class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">${escapeHtml(t('adminNoChanges', null, 'Без изменений'))}</p>`
        : changes.map(renderDiffItem).join('');
      editDetailListEl.innerHTML = listHtml + buildAdminReviewActions(item);
    }
  }

  if (editDetailPaneEl) editDetailPaneEl.classList.remove('hidden');
  if (adminAppEl) adminAppEl.classList.add('edit-pane-open');
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
  const mergeBtn = document.getElementById('edit-merge-all-btn');
  const applyDecisionsBtn = document.getElementById('edit-apply-decisions-btn');
  const rejectBtn = document.getElementById('edit-reject-btn');
  const statusEl = document.getElementById('edit-admin-status');
  if (mergeBtn) mergeBtn.addEventListener('click', () => {
    setAllReviewFieldDecisions('accept');
    if (statusEl) statusEl.textContent = t('adminAllAcceptedMarked', null, 'Все теги отмечены как принятые. Нажмите "Применить решения".');
  });
  if (applyDecisionsBtn) applyDecisionsBtn.addEventListener('click', () => submitAdminModeration('apply'));
  if (rejectBtn) rejectBtn.addEventListener('click', () => {
    setAllReviewFieldDecisions('reject');
    if (statusEl) statusEl.textContent = t('adminAllRejectedMarked', null, 'Все теги отмечены как отклоненные. Нажмите "Применить решения".');
  });
  highlightedEditKeys = new Set([osmKey]);
  applyEditedBuildingsPaint();
}

async function toggleUserPermission(email, canEdit) {
  const resp = await fetch('/api/admin/users/edit-permission', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, canEdit })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    setText(usersStatusEl, String(data?.error || t('adminEditPermissionFailed', null, 'Не удалось изменить право редактирования')));
    return false;
  }
  setText(usersStatusEl, t('adminUpdated', { email }, `Обновлено: ${email}`));
  return true;
}

async function toggleUserRole(email, isAdmin) {
  const resp = await fetch('/api/admin/users/role', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, isAdmin })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    setText(usersStatusEl, String(data?.error || t('adminRoleFailed', null, 'Не удалось изменить роль')));
    return false;
  }
  setText(usersStatusEl, t('adminRoleUpdated', { email }, `Роль обновлена: ${email}`));
  return true;
}

async function restoreFromUrl() {
  const fromUrl = readStateFromUrl();
  if (fromUrl.tab) {
    adminState.tab = fromUrl.tab === 'edits'
      ? 'edits'
      : (fromUrl.tab === 'guide'
        ? 'guide'
        : (fromUrl.tab === 'uikit' ? 'uikit' : 'users'));
  }
  adminState.user = String(fromUrl.user || '').trim().toLowerCase();
  adminState.edit = String(fromUrl.edit || '').trim();
  adminState.q = String(fromUrl.q || '').trim();
  adminState.role = String(fromUrl.role || '').trim();
  adminState.canEdit = String(fromUrl.canEdit || '').trim();
  adminState.hasEdits = String(fromUrl.hasEdits || '').trim();
  adminState.sortBy = String(fromUrl.sortBy || 'createdAt').trim();
  adminState.sortDir = String(fromUrl.sortDir || 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
  adminState.editsQ = String(fromUrl.editsQ || '').trim();
  adminState.editsDate = String(fromUrl.editsDate || '').trim();
  adminState.editsUser = String(fromUrl.editsUser || '').trim().toLowerCase();
  adminState.editsStatus = String(fromUrl.editsStatus || 'pending').trim().toLowerCase() || 'pending';

  setTab(adminState.tab, { push: false });
  await loadUsers({ silent: true });
  await loadAllEdits();
  applyStateToControls();
  applyEditsFilters();

  writeStateToUrl({ replace: true });

  if (adminState.edit) {
    await openEditDetails(adminState.edit, { push: false });
  }
}

if (tabUsersEl) tabUsersEl.addEventListener('click', () => setTab('users'));
if (tabEditsEl) tabEditsEl.addEventListener('click', () => setTab('edits'));
if (tabGuideEl) tabGuideEl.addEventListener('click', () => setTab('guide'));
if (tabUiKitEl) tabUiKitEl.addEventListener('click', () => setTab('uikit'));

if (usersRefreshEl) {
  usersRefreshEl.addEventListener('click', async () => {
    collectUsersFiltersFromControls();
    writeStateToUrl();
    await loadUsers();
  });
}

for (const el of [usersRoleFilterEl, usersCanEditFilterEl, usersHasEditsFilterEl, usersSortByEl, usersSortDirEl]) {
  if (!el) continue;
  el.addEventListener('change', async () => {
    collectUsersFiltersFromControls();
    writeStateToUrl();
    await loadUsers();
  });
}

if (usersSearchEl) {
  usersSearchEl.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    collectUsersFiltersFromControls();
    writeStateToUrl();
    await loadUsers();
  });
}

if (usersListEl) {
  usersListEl.addEventListener('click', async (event) => {
    const actionEl = event.target?.closest?.('[data-action]');
    if (!actionEl) return;

    const action = String(actionEl.getAttribute('data-action') || '');
    const email = String(actionEl.getAttribute('data-email') || '').trim().toLowerCase();

    if (action === 'open-user-edits' && email) {
      adminState.editsUser = email;
      if (editsUserFilterEl) editsUserFilterEl.value = email;
      setTab('edits');
      applyEditsFilters();
      writeStateToUrl();
      return;
    }

    if (action === 'toggle-edit' && email) {
      const current = actionEl.getAttribute('data-can-edit') === '1';
      const ok = await toggleUserPermission(email, !current);
      if (ok) {
        await loadUsers();
      }
      return;
    }

    if (action === 'toggle-admin' && email) {
      if (actionEl.getAttribute('data-role-locked') === '1' || actionEl.disabled) return;
      const current = actionEl.getAttribute('data-is-admin') === '1';
      const ok = await toggleUserRole(email, !current);
      if (ok) {
        await loadUsers();
      }
    }
  });
}

for (const el of [editsSearchEl, editsDateFilterEl, editsUserFilterEl, editsStatusFilterEl]) {
  if (!el) continue;
  const eventName = el === editsSearchEl ? 'input' : 'change';
  el.addEventListener(eventName, () => {
    collectEditsFiltersFromControls();
    applyEditsFilters();
    writeStateToUrl();
  });
}

if (editsListEl) {
  editsListEl.addEventListener('click', async (event) => {
    const row = event.target?.closest?.('[data-action="open-edit"]');
    if (!row) return;
    const editId = String(row.getAttribute('data-edit-id') || '').trim();
    await openEditDetails(editId);
  });
}

if (editDetailListEl) {
  editDetailListEl.addEventListener('click', (event) => {
    const actionEl = event.target?.closest?.('[data-field-action][data-field-name]');
    if (!actionEl) return;
    event.preventDefault();
    const decision = String(actionEl.getAttribute('data-field-action') || '').trim().toLowerCase();
    const field = String(actionEl.getAttribute('data-field-name') || '').trim();
    if (!field || !['accept', 'reject'].includes(decision)) return;
    setReviewFieldDecision(field, decision);
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

window.addEventListener('popstate', async () => {
  await restoreFromUrl();
});

(async () => {
  initUiKitClasses();
  renderAdminGuide();
  renderBuildInfoLink();
  initThemeToggle();
  initNavMenu();
  initMapReturnLinks();
  setAppVisibility(false);
  const user = await loadMe();
  if (!user || !user.isAdmin) return;
  setAppVisibility(true);
  await restoreFromUrl();
})();
