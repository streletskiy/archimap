let csrfToken = null;
const I18N_RU = window.__ARCHIMAP_I18N_RU || {};
const UI_TEXT = Object.freeze(I18N_RU.ui || {});

const accountSubtitleEl = document.getElementById('account-subtitle');
const navLogoLinkEl = document.getElementById('nav-logo-link');
const mapReturnLinkEl = document.getElementById('map-return-link');
const adminLinkEl = document.getElementById('admin-link');
const logoutBtnEl = document.getElementById('account-logout-btn');
const themeToggleEl = document.getElementById('theme-toggle');
const navMenuButtonEl = document.getElementById('nav-menu-button');
const navMenuPanelEl = document.getElementById('nav-menu-panel');
const tabProfileEl = document.getElementById('account-tab-profile');
const tabEditsEl = document.getElementById('account-tab-edits');
const profilePanelEl = document.getElementById('account-profile-panel');
const editsPanelEl = document.getElementById('account-edits-panel');
const profileFormEl = document.getElementById('profile-form');
const firstNameEl = document.getElementById('first-name');
const lastNameEl = document.getElementById('last-name');
const profileStatusEl = document.getElementById('profile-status');
const passwordFormEl = document.getElementById('password-form');
const currentPasswordEl = document.getElementById('current-password');
const newPasswordEl = document.getElementById('new-password');
const newPasswordConfirmEl = document.getElementById('new-password-confirm');
const passwordStatusEl = document.getElementById('password-status');
const editsStatusEl = document.getElementById('account-edits-status');
const editsListEl = document.getElementById('account-edits-list');
const editDetailModalEl = document.getElementById('account-edit-detail-modal');
const editDetailCloseEl = document.getElementById('account-edit-detail-close');
const editDetailTitleEl = document.getElementById('account-edit-detail-title');
const editDetailMetaEl = document.getElementById('account-edit-detail-meta');
const editDetailListEl = document.getElementById('account-edit-detail-list');
const THEME_STORAGE_KEY = 'archimap-theme';
const LAST_MAP_HASH_STORAGE_KEY = 'archimap-last-map-hash';

const nativeFetch = window.fetch.bind(window);
const accountState = { tab: 'profile', edit: '' };

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

function setTab(nextTab, options = {}) {
  const push = options.push !== false;
  accountState.tab = nextTab === 'edits' ? 'edits' : 'profile';

  if (profilePanelEl) profilePanelEl.classList.toggle('hidden', accountState.tab !== 'profile');
  if (editsPanelEl) editsPanelEl.classList.toggle('hidden', accountState.tab !== 'edits');

  const activeBtn = 'bg-slate-900 text-white hover:bg-slate-800';
  const idleBtn = 'text-slate-700 hover:bg-slate-100';
  if (tabProfileEl) tabProfileEl.className = `rounded-md px-3 py-1.5 text-sm font-semibold ${accountState.tab === 'profile' ? activeBtn : idleBtn}`;
  if (tabEditsEl) tabEditsEl.className = `rounded-md px-3 py-1.5 text-sm font-semibold ${accountState.tab === 'edits' ? activeBtn : idleBtn}`;

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
  setText(accountSubtitleEl, `${title} (${String(user.email || user.username || t('accountEmailMissing', null, 'без email'))})`);

  if (firstNameEl) firstNameEl.value = String(user.firstName || '');
  if (lastNameEl) lastNameEl.value = String(user.lastName || '');

  if (adminLinkEl) adminLinkEl.classList.toggle('hidden', !Boolean(user.isAdmin));
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
    editsListEl.innerHTML = `<p class="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">${escapeHtml(t('adminEditsEmpty', null, 'Локальных правок нет.'))}</p>`;
    return;
  }

  editsListEl.innerHTML = items.map((item) => {
    const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`;
    const updatedAt = String(item?.updatedAt || '-');
    const changesCount = Array.isArray(item?.changes) ? item.changes.length : 0;
    return `
      <button data-action="open-edit" data-edit-key="${escapeHtml(osmKey)}" class="rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-soft hover:border-indigo-300 hover:bg-indigo-50">
        <div class="text-sm font-semibold text-slate-900">${escapeHtml(osmKey)}</div>
        <div class="mt-1 text-xs text-slate-600">${escapeHtml(updatedAt)}</div>
        <div class="mt-2 text-xs text-slate-700">Изменений: ${changesCount}</div>
      </button>
    `;
  }).join('');
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

  const items = Array.isArray(data.items) ? data.items : [];
  setText(editsStatusEl, t('adminEditsCount', { count: Number(data.total || items.length) }, `Локальных правок: ${Number(data.total || items.length)}`));
  renderOwnEdits(items);
}

function closeEditModal(options = {}) {
  const push = options.push !== false;
  accountState.edit = '';
  if (editDetailModalEl) editDetailModalEl.classList.add('hidden');
  if (push) writeStateToUrl();
}

async function openEditDetails(editKey, options = {}) {
  const push = options.push !== false;
  const parsed = parseEditKey(editKey);
  if (!parsed) return;

  let resp;
  try {
    resp = await fetch(`/api/account/edits/${encodeURIComponent(parsed.osmType)}/${encodeURIComponent(parsed.osmId)}`);
  } catch {
    return;
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.item) return;

  const item = data.item;
  accountState.edit = parsed.key;
  if (push) writeStateToUrl();

  if (editDetailTitleEl) editDetailTitleEl.textContent = `Правка ${parsed.key}`;
  if (editDetailMetaEl) editDetailMetaEl.textContent = `${String(item.updatedAt || '-')}`;
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

if (tabProfileEl) tabProfileEl.addEventListener('click', () => setTab('profile'));
if (tabEditsEl) {
  tabEditsEl.addEventListener('click', async () => {
    setTab('edits');
    await loadOwnEdits();
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

async function restoreFromUrl() {
  const fromUrl = readStateFromUrl();
  accountState.tab = fromUrl.tab === 'edits' ? 'edits' : 'profile';
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
  initThemeToggle();
  initNavMenu();
  initMapReturnLinks();
  await confirmRegistrationTokenIfPresent();
  await loadMe();
  await restoreFromUrl();
})();
