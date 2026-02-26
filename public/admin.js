let csrfToken = null;
let isMasterAdmin = false;
let currentUserEmail = null;
let currentEditKey = null;
const adminState = {
  tab: 'users',
  q: '',
  role: '',
  canEdit: '',
  hasEdits: '',
  sortBy: 'createdAt',
  sortDir: 'desc',
  user: '',
  edit: ''
};

const I18N_RU = window.__ARCHIMAP_I18N_RU || {};
const UI_TEXT = Object.freeze(I18N_RU.ui || {});

const adminAppEl = document.getElementById('admin-app');
const adminLoadingEl = document.getElementById('admin-loading');
const subtitleEl = document.getElementById('admin-subtitle');
const navLogoLinkEl = document.getElementById('nav-logo-link');
const mapReturnLinkEl = document.getElementById('map-return-link');
const logoutBtnEl = document.getElementById('admin-logout-btn');
const themeToggleEl = document.getElementById('theme-toggle');
const navMenuButtonEl = document.getElementById('nav-menu-button');
const navMenuPanelEl = document.getElementById('nav-menu-panel');
const tabUsersEl = document.getElementById('tab-users');
const tabEditsEl = document.getElementById('tab-edits');
const usersPanelEl = document.getElementById('users-panel');
const editsPanelEl = document.getElementById('edits-panel');
const usersSearchEl = document.getElementById('users-search');
const usersRoleFilterEl = document.getElementById('users-role-filter');
const usersCanEditFilterEl = document.getElementById('users-can-edit-filter');
const usersHasEditsFilterEl = document.getElementById('users-has-edits-filter');
const usersSortByEl = document.getElementById('users-sort-by');
const usersSortDirEl = document.getElementById('users-sort-dir');
const usersRefreshEl = document.getElementById('users-refresh');
const usersStatusEl = document.getElementById('users-status');
const usersListEl = document.getElementById('users-list');
const userDetailStatusEl = document.getElementById('user-detail-status');
const userDetailEl = document.getElementById('user-detail');
const userDetailNameEl = document.getElementById('user-detail-name');
const userDetailEmailEl = document.getElementById('user-detail-email');
const userDetailMetaEl = document.getElementById('user-detail-meta');
const userEditsListEl = document.getElementById('user-edits-list');
const editsStatusEl = document.getElementById('edits-status');
const editsListEl = document.getElementById('edits-list');
const editDetailModalEl = document.getElementById('edit-detail-modal');
const editDetailCloseEl = document.getElementById('edit-detail-close');
const editDetailTitleEl = document.getElementById('edit-detail-title');
const editDetailMetaEl = document.getElementById('edit-detail-meta');
const editDetailListEl = document.getElementById('edit-detail-list');
const THEME_STORAGE_KEY = 'archimap-theme';
const LAST_MAP_HASH_STORAGE_KEY = 'archimap-last-map-hash';

const nativeFetch = window.fetch.bind(window);

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
    const tab = String(url.searchParams.get('tab') || '').trim();
    const user = String(url.searchParams.get('user') || '').trim().toLowerCase();
    const edit = String(url.searchParams.get('edit') || '').trim();
    const q = String(url.searchParams.get('q') || '').trim();
    const role = String(url.searchParams.get('role') || '').trim();
    const canEdit = String(url.searchParams.get('canEdit') || '').trim();
    const hasEdits = String(url.searchParams.get('hasEdits') || '').trim();
    const sortBy = String(url.searchParams.get('sortBy') || '').trim();
    const sortDir = String(url.searchParams.get('sortDir') || '').trim();
    return { tab, user, edit, q, role, canEdit, hasEdits, sortBy, sortDir };
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
}

function setTab(nextTab, options = {}) {
  adminState.tab = nextTab === 'edits' ? 'edits' : 'users';
  const push = options.push !== false;

  if (usersPanelEl) usersPanelEl.classList.toggle('hidden', adminState.tab !== 'users');
  if (editsPanelEl) editsPanelEl.classList.toggle('hidden', adminState.tab !== 'edits');

  const activeBtn = 'bg-slate-900 text-white hover:bg-slate-800';
  const idleBtn = 'text-slate-700 hover:bg-slate-100';
  if (tabUsersEl) tabUsersEl.className = `rounded-md px-3 py-1.5 text-sm font-semibold ${adminState.tab === 'users' ? activeBtn : idleBtn}`;
  if (tabEditsEl) tabEditsEl.className = `rounded-md px-3 py-1.5 text-sm font-semibold ${adminState.tab === 'edits' ? activeBtn : idleBtn}`;

  if (push) writeStateToUrl();
}

function collectFiltersFromControls() {
  adminState.q = String(usersSearchEl?.value || '').trim();
  adminState.role = String(usersRoleFilterEl?.value || '').trim();
  adminState.canEdit = String(usersCanEditFilterEl?.value || '').trim();
  adminState.hasEdits = String(usersHasEditsFilterEl?.value || '').trim();
  adminState.sortBy = String(usersSortByEl?.value || 'createdAt').trim();
  adminState.sortDir = String(usersSortDirEl?.value || 'desc').trim();
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
  if (!Array.isArray(items) || items.length === 0) {
    usersListEl.innerHTML = `<tr><td colspan="5" class="px-4 py-6 text-center text-sm text-slate-600">${escapeHtml(t('adminUsersEmpty', null, 'Пользователи не найдены.'))}</td></tr>`;
    return;
  }

  usersListEl.innerHTML = items.map((item) => {
    const email = String(item?.email || '');
    const firstName = String(item?.firstName || '').trim();
    const lastName = String(item?.lastName || '').trim();
    const displayName = [firstName, lastName].filter(Boolean).join(' ') || email;
    const isAdmin = Boolean(item?.isAdmin);
    const canEdit = Boolean(item?.canEdit);
    const editsCount = Number(item?.editsCount || 0);
    const createdAt = String(item?.createdAt || '').replace('T', ' ').replace('Z', '');

    return `
      <tr class="border-t border-slate-200 hover:bg-slate-50 ${adminState.user === email ? 'bg-indigo-50' : ''}" data-user-row="${escapeHtml(email)}">
        <td class="px-4 py-3">
          <button data-action="select-user" data-email="${escapeHtml(email)}" class="text-left">
            <div class="font-semibold text-slate-900">${escapeHtml(displayName)}</div>
            <div class="text-xs text-slate-500">${escapeHtml(email)}</div>
          </button>
        </td>
        <td class="px-4 py-3 text-xs">
          <span class="rounded-full px-2 py-1 ${isAdmin ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-700'}">${isAdmin ? 'admin' : 'user'}</span>
          <span class="ml-1 rounded-full px-2 py-1 ${canEdit ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-700'}">${canEdit ? 'edit:on' : 'edit:off'}</span>
        </td>
        <td class="px-4 py-3 text-sm text-slate-700">${editsCount}</td>
        <td class="px-4 py-3 text-xs text-slate-600">${escapeHtml(createdAt || '-')}</td>
        <td class="px-4 py-3 text-right">
          <div class="inline-flex gap-1">
            <button data-action="toggle-edit" data-email="${escapeHtml(email)}" data-can-edit="${canEdit ? '1' : '0'}" class="rounded border px-2 py-1 text-xs ${canEdit ? 'border-emerald-300 text-emerald-700' : 'border-slate-300 text-slate-700'}">${canEdit ? escapeHtml(t('adminToggleEditOn', null, 'Запретить правки')) : escapeHtml(t('adminToggleEditOff', null, 'Разрешить правки'))}</button>
            <button data-action="toggle-admin" data-email="${escapeHtml(email)}" data-is-admin="${isAdmin ? '1' : '0'}" class="rounded border px-2 py-1 text-xs ${isAdmin ? 'border-indigo-300 text-indigo-700' : 'border-slate-300 text-slate-700'} ${isMasterAdmin ? '' : 'hidden'}">${isAdmin ? escapeHtml(t('adminToggleRoleOn', null, 'Снять admin')) : escapeHtml(t('adminToggleRoleOff', null, 'Сделать admin'))}</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderEditCards(items) {
  if (!editsListEl) return;
  if (!Array.isArray(items) || items.length === 0) {
    editsListEl.innerHTML = `<p class="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">${escapeHtml(t('adminEditsEmpty', null, 'Локальных правок нет.'))}</p>`;
    return;
  }

  editsListEl.innerHTML = items.map((item) => {
    const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`;
    const updatedBy = String(item?.updatedBy || '-');
    const updatedAt = String(item?.updatedAt || '-');
    const changesCount = Array.isArray(item?.changes) ? item.changes.length : 0;
    return `
      <button data-action="open-edit" data-edit-key="${escapeHtml(osmKey)}" class="rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-soft hover:border-indigo-300 hover:bg-indigo-50">
        <div class="text-sm font-semibold text-slate-900">${escapeHtml(osmKey)}</div>
        <div class="mt-1 text-xs text-slate-600">${escapeHtml(updatedBy)} | ${escapeHtml(updatedAt)}</div>
        <div class="mt-2 text-xs text-slate-700">Изменений: ${changesCount}</div>
      </button>
    `;
  }).join('');
}

function renderUserEdits(items) {
  if (!userEditsListEl) return;
  if (!Array.isArray(items) || items.length === 0) {
    userEditsListEl.innerHTML = `<p class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">${escapeHtml(t('adminEditsEmpty', null, 'Локальных правок нет.'))}</p>`;
    return;
  }

  userEditsListEl.innerHTML = items.map((item) => {
    const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`;
    const updatedAt = String(item?.updatedAt || '-');
    return `
      <button data-action="open-edit" data-edit-key="${escapeHtml(osmKey)}" class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50">
        <div class="text-sm font-semibold text-slate-900">${escapeHtml(osmKey)}</div>
        <div class="text-xs text-slate-600">${escapeHtml(updatedAt)}</div>
      </button>
    `;
  }).join('');
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
    resp = await fetch('/api/admin/building-edits');
  } catch {
    setText(editsStatusEl, t('adminEditsNetworkError', null, 'Ошибка сети'));
    return [];
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    setText(editsStatusEl, String(data?.error || t('adminEditsLoadFailed', null, 'Не удалось загрузить правки')));
    return [];
  }

  const items = Array.isArray(data.items) ? data.items : [];
  renderEditCards(items);
  setText(editsStatusEl, t('adminEditsCount', { count: Number(data.total || items.length) }, `Локальных правок: ${Number(data.total || items.length)}`));
  return items;
}

async function openUserDetails(email, options = {}) {
  const push = options.push !== false;
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return;

  currentUserEmail = normalized;
  adminState.user = normalized;
  adminState.tab = 'users';
  if (push) writeStateToUrl();

  if (userDetailEl) userDetailEl.classList.remove('hidden');
  setText(userDetailStatusEl, t('adminUsersLoading', null, 'Загрузка...'));

  const userUrl = `/api/admin/users/${encodeURIComponent(normalized)}`;
  const editsUrl = `/api/admin/users/${encodeURIComponent(normalized)}/edits`;
  const [userResp, editsResp] = await Promise.all([
    fetch(userUrl).catch(() => null),
    fetch(editsUrl).catch(() => null)
  ]);

  if (!userResp || !editsResp) {
    setText(userDetailStatusEl, t('adminUsersNetworkError', null, 'Ошибка сети'));
    return;
  }

  const userData = await userResp.json().catch(() => ({}));
  const editsData = await editsResp.json().catch(() => ({}));

  if (!userResp.ok) {
    setText(userDetailStatusEl, String(userData?.error || t('adminUsersLoadFailed', null, 'Не удалось загрузить пользователей')));
    return;
  }
  if (!editsResp.ok) {
    setText(userDetailStatusEl, String(editsData?.error || t('adminEditsLoadFailed', null, 'Не удалось загрузить правки')));
    return;
  }

  const user = userData.item || {};
  setText(userDetailStatusEl, '');
  setText(userDetailNameEl, [String(user.firstName || '').trim(), String(user.lastName || '').trim()].filter(Boolean).join(' ') || String(user.email || '-'));
  setText(userDetailEmailEl, String(user.email || '-'));
  setText(userDetailMetaEl, `Роль: ${user.isAdmin ? 'admin' : 'user'} | Редактирование: ${user.canEdit ? 'разрешено' : 'запрещено'} | Правок: ${Number(user.editsCount || 0)}`);

  renderUserEdits(Array.isArray(editsData.items) ? editsData.items : []);
}

function closeEditModal(options = {}) {
  const push = options.push !== false;
  currentEditKey = null;
  adminState.edit = '';
  if (editDetailModalEl) editDetailModalEl.classList.add('hidden');
  if (push) writeStateToUrl();
}

async function openEditDetails(editKey, options = {}) {
  const push = options.push !== false;
  const parsed = parseEditKey(editKey);
  if (!parsed) return;

  const url = `/api/admin/building-edits/${encodeURIComponent(parsed.osmType)}/${encodeURIComponent(parsed.osmId)}`;
  let resp;
  try {
    resp = await fetch(url);
  } catch {
    return;
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.item) return;

  const item = data.item;
  currentEditKey = parsed.key;
  adminState.edit = parsed.key;
  if (push) writeStateToUrl();

  if (editDetailTitleEl) editDetailTitleEl.textContent = `Правка ${parsed.key}`;
  if (editDetailMetaEl) editDetailMetaEl.textContent = `${String(item.updatedBy || '-')} | ${String(item.updatedAt || '-')}`;
  if (editDetailListEl) {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    editDetailListEl.innerHTML = changes.length === 0
      ? `<p class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">${escapeHtml(t('adminNoChanges', null, 'Без изменений'))}</p>`
      : changes.map((change) => `
        <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p class="text-sm font-semibold text-slate-900">${escapeHtml(String(change.label || '-'))}</p>
          <p class="text-xs text-slate-600">OSM: ${escapeHtml(String(change.osmValue ?? '—'))}</p>
          <p class="text-xs text-slate-800">Локально: ${escapeHtml(String(change.localValue ?? '—'))}</p>
        </div>
      `).join('');
  }

  if (editDetailModalEl) editDetailModalEl.classList.remove('hidden');
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
  if (fromUrl.tab) adminState.tab = fromUrl.tab === 'edits' ? 'edits' : 'users';
  adminState.user = String(fromUrl.user || '').trim().toLowerCase();
  adminState.edit = String(fromUrl.edit || '').trim();
  adminState.q = String(fromUrl.q || '').trim();
  adminState.role = String(fromUrl.role || '').trim();
  adminState.canEdit = String(fromUrl.canEdit || '').trim();
  adminState.hasEdits = String(fromUrl.hasEdits || '').trim();
  adminState.sortBy = String(fromUrl.sortBy || 'createdAt').trim();
  adminState.sortDir = String(fromUrl.sortDir || 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';

  applyStateToControls();
  setTab(adminState.tab, { push: false });
  writeStateToUrl({ replace: true });

  await loadUsers({ silent: true });
  await loadAllEdits();

  if (adminState.user) {
    await openUserDetails(adminState.user, { push: false });
  }
  if (adminState.edit) {
    await openEditDetails(adminState.edit, { push: false });
  }
}

if (tabUsersEl) tabUsersEl.addEventListener('click', () => setTab('users'));
if (tabEditsEl) tabEditsEl.addEventListener('click', () => setTab('edits'));

if (usersRefreshEl) {
  usersRefreshEl.addEventListener('click', async () => {
    collectFiltersFromControls();
    writeStateToUrl();
    await loadUsers();
  });
}

for (const el of [usersRoleFilterEl, usersCanEditFilterEl, usersHasEditsFilterEl, usersSortByEl, usersSortDirEl]) {
  if (!el) continue;
  el.addEventListener('change', async () => {
    collectFiltersFromControls();
    writeStateToUrl();
    await loadUsers();
  });
}

if (usersSearchEl) {
  usersSearchEl.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    collectFiltersFromControls();
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

    if (action === 'select-user' && email) {
      await openUserDetails(email);
      return;
    }

    if (action === 'toggle-edit' && email) {
      const current = actionEl.getAttribute('data-can-edit') === '1';
      const ok = await toggleUserPermission(email, !current);
      if (ok) {
        await loadUsers();
        if (adminState.user === email) await openUserDetails(email, { push: false });
      }
      return;
    }

    if (action === 'toggle-admin' && email) {
      const current = actionEl.getAttribute('data-is-admin') === '1';
      const ok = await toggleUserRole(email, !current);
      if (ok) {
        await loadUsers();
        if (adminState.user === email) await openUserDetails(email, { push: false });
      }
    }
  });
}

if (userEditsListEl) {
  userEditsListEl.addEventListener('click', async (event) => {
    const actionEl = event.target?.closest?.('[data-action="open-edit"]');
    if (!actionEl) return;
    const editKey = String(actionEl.getAttribute('data-edit-key') || '').trim();
    await openEditDetails(editKey);
  });
}

if (editsListEl) {
  editsListEl.addEventListener('click', async (event) => {
    const actionEl = event.target?.closest?.('[data-action="open-edit"]');
    if (!actionEl) return;
    const editKey = String(actionEl.getAttribute('data-edit-key') || '').trim();
    await openEditDetails(editKey);
  });
}

if (editDetailCloseEl) editDetailCloseEl.addEventListener('click', () => closeEditModal());
if (editDetailModalEl) {
  editDetailModalEl.addEventListener('click', (event) => {
    if (event.target === editDetailModalEl) closeEditModal();
  });
}

if (logoutBtnEl) {
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
  initThemeToggle();
  initNavMenu();
  initMapReturnLinks();
  setAppVisibility(false);
  const user = await loadMe();
  if (!user || !user.isAdmin) return;
  setAppVisibility(true);
  await restoreFromUrl();
})();
