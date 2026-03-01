const panelPageUtils = window.ArchiMapPanelPage || {};
const textTools = window.ArchiMapTextUtils?.createUiTextTools
  ? window.ArchiMapTextUtils.createUiTextTools()
  : null;
const t = textTools?.t || ((_, __, fallback = '') => String(fallback || ''));

const navLogoLinkEl = document.getElementById('nav-logo-link');
const mapReturnMenuLinkEl = document.getElementById('map-return-menu-link');
const navMenuButtonEl = document.getElementById('nav-menu-button');
const navMenuPanelEl = document.getElementById('nav-menu-panel');
const themeToggleEl = document.getElementById('theme-toggle');
const infoPageTitleEl = document.getElementById('info-page-title');
const infoHeadingEl = document.getElementById('info-heading');
const infoSubheadingEl = document.getElementById('info-subheading');
const infoTabAboutEl = document.getElementById('info-tab-about');
const infoTabUserAgreementEl = document.getElementById('info-tab-user-agreement');
const infoTabPrivacyPolicyEl = document.getElementById('info-tab-privacy-policy');
const infoPanelAboutEl = document.getElementById('info-panel-about');
const infoPanelUserAgreementEl = document.getElementById('info-panel-user-agreement');
const infoPanelPrivacyPolicyEl = document.getElementById('info-panel-privacy-policy');
const infoAboutTitleEl = document.getElementById('info-about-title');
const infoAboutTextEl = document.getElementById('info-about-text');
const infoTechTitleEl = document.getElementById('info-tech-title');
const infoTechVersionLabelEl = document.getElementById('info-tech-version-label');
const infoTechCommitLabelEl = document.getElementById('info-tech-commit-label');
const infoTechRepoLabelEl = document.getElementById('info-tech-repo-label');
const infoUserAgreementTitleEl = document.getElementById('info-user-agreement-title');
const infoUserAgreementContentEl = document.getElementById('info-user-agreement-content');
const infoPrivacyPolicyTitleEl = document.getElementById('info-privacy-policy-title');
const infoPrivacyPolicyContentEl = document.getElementById('info-privacy-policy-content');
const infoBuildVersionEl = document.getElementById('info-build-version');
const infoBuildShaEl = document.getElementById('info-build-sha');
const infoBuildRepoLinkEl = document.getElementById('info-build-repo-link');

const BUILD_INFO_CONFIG = Object.freeze({
  shortSha: String(window.__ARCHIMAP_CONFIG?.buildInfo?.shortSha || 'unknown').trim() || 'unknown',
  version: String(window.__ARCHIMAP_CONFIG?.buildInfo?.version || 'dev').trim() || 'dev',
  repoUrl: String(window.__ARCHIMAP_CONFIG?.buildInfo?.repoUrl || 'https://github.com/streletskiy/archimap').trim() || 'https://github.com/streletskiy/archimap'
});

const infoState = {
  tab: 'about',
  loaded: {
    'user-agreement': false,
    'privacy-policy': false
  }
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineMarkdownToHtml(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="font-semibold text-indigo-700 underline underline-offset-2 hover:text-indigo-800">$1</a>');
}

function markdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inList = false;
  let paragraphParts = [];

  function flushParagraph() {
    if (paragraphParts.length === 0) return;
    const text = paragraphParts.join(' ').trim();
    if (text) out.push(`<p class="text-sm leading-7 text-slate-700">${inlineMarkdownToHtml(text)}</p>`);
    paragraphParts = [];
  }

  function closeList() {
    if (!inList) return;
    out.push('</ul>');
    inList = false;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      closeList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = headingMatch[1].length;
      const text = inlineMarkdownToHtml(headingMatch[2]);
      if (level === 1) out.push(`<h1 class="text-2xl font-extrabold text-slate-900 md:text-3xl">${text}</h1>`);
      else if (level === 2) out.push(`<h2 class="mt-6 text-xl font-bold text-slate-900">${text}</h2>`);
      else out.push(`<h3 class="mt-4 text-base font-semibold text-slate-900">${text}</h3>`);
      continue;
    }

    if (line === '---') {
      flushParagraph();
      closeList();
      out.push('<hr class="my-5 border-slate-200" />');
      continue;
    }

    const listMatch = line.match(/^[-*]\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      if (!inList) {
        out.push('<ul class="list-disc space-y-1 pl-6 text-sm leading-7 text-slate-700">');
        inList = true;
      }
      out.push(`<li>${inlineMarkdownToHtml(listMatch[1])}</li>`);
      continue;
    }

    closeList();
    paragraphParts.push(line);
  }

  flushParagraph();
  closeList();
  return out.join('\n');
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
}

function setTabButtonState(button, active) {
  if (!button) return;
  const ui = window.ArchiMapUI || null;
  if (ui && typeof ui.tabButtonClass === 'function') {
    button.className = ui.tabButtonClass(active);
    return;
  }
  button.className = active
    ? 'ui-tab-btn ui-tab-btn-active'
    : 'ui-tab-btn';
}

function getNormalizedTab(raw) {
  const tab = String(raw || '').trim().toLowerCase();
  if (tab === 'user-agreement') return tab;
  if (tab === 'privacy-policy') return tab;
  return 'about';
}

function updateTabInUrl(replace = false) {
  const url = new URL(window.location.href);
  if (infoState.tab === 'about') {
    url.searchParams.delete('tab');
  } else {
    url.searchParams.set('tab', infoState.tab);
  }
  if (replace) history.replaceState(null, '', url.toString());
  else history.pushState(null, '', url.toString());
}

function applyInfoTexts() {
  if (infoPageTitleEl) infoPageTitleEl.textContent = t('infoPageTitle', null, 'Информация | archimap');
  if (infoHeadingEl) infoHeadingEl.textContent = t('infoHeading', null, 'Информация');
  if (infoSubheadingEl) infoSubheadingEl.textContent = t('infoSubheading', null, 'О сервисе, техническая информация и юридические документы.');
  if (infoTabAboutEl) infoTabAboutEl.textContent = t('infoTabAbout', null, 'О сервисе');
  if (infoTabUserAgreementEl) infoTabUserAgreementEl.textContent = t('infoTabUserAgreement', null, 'Пользовательское соглашение');
  if (infoTabPrivacyPolicyEl) infoTabPrivacyPolicyEl.textContent = t('infoTabPrivacyPolicy', null, 'Политика конфиденциальности');
  if (infoAboutTitleEl) infoAboutTitleEl.textContent = t('infoAboutTitle', null, 'О сервисе');
  if (infoAboutTextEl) infoAboutTextEl.textContent = t('infoAboutText', null, 'Archimap помогает собирать и модератировать архитектурные данные зданий на карте. Изменения пользователей проходят модерацию и могут использоваться в экосистеме OSM в соответствии с правилами лицензирования.');
  if (infoTechTitleEl) infoTechTitleEl.textContent = t('infoTechTitle', null, 'Техническая информация');
  if (infoTechVersionLabelEl) infoTechVersionLabelEl.textContent = t('infoTechVersionLabel', null, 'Версия');
  if (infoTechCommitLabelEl) infoTechCommitLabelEl.textContent = t('infoTechCommitLabel', null, 'Коммит');
  if (infoTechRepoLabelEl) infoTechRepoLabelEl.textContent = t('infoTechRepoLabel', null, 'Репозиторий');
}

async function loadLegalDoc(slug) {
  const isUserAgreement = slug === 'user-agreement';
  const titleEl = isUserAgreement ? infoUserAgreementTitleEl : infoPrivacyPolicyTitleEl;
  const contentEl = isUserAgreement ? infoUserAgreementContentEl : infoPrivacyPolicyContentEl;
  if (!contentEl) return;
  if (infoState.loaded[slug]) return;

  contentEl.innerHTML = `<p class="text-sm text-slate-600">${t('infoDocLoading', null, 'Загрузка документа...')}</p>`;
  let resp;
  try {
    resp = await fetch(`/api/legal-docs/${encodeURIComponent(slug)}`);
  } catch {
    contentEl.innerHTML = `<p class="text-sm text-rose-700">${t('infoDocLoadNetworkError', null, 'Ошибка сети при загрузке документа.')}</p>`;
    return;
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || typeof data?.markdown !== 'string') {
    contentEl.innerHTML = `<p class="text-sm text-rose-700">${String(data?.error || t('infoDocLoadFailed', null, 'Не удалось загрузить документ'))}</p>`;
    return;
  }

  if (titleEl) titleEl.textContent = String(data.title || titleEl.textContent || '');
  contentEl.innerHTML = markdownToHtml(String(data.markdown || ''));
  infoState.loaded[slug] = true;
}

async function setTab(nextTab, options = {}) {
  infoState.tab = getNormalizedTab(nextTab);
  const push = options.push !== false;

  if (infoPanelAboutEl) infoPanelAboutEl.classList.toggle('hidden', infoState.tab !== 'about');
  if (infoPanelUserAgreementEl) infoPanelUserAgreementEl.classList.toggle('hidden', infoState.tab !== 'user-agreement');
  if (infoPanelPrivacyPolicyEl) infoPanelPrivacyPolicyEl.classList.toggle('hidden', infoState.tab !== 'privacy-policy');

  setTabButtonState(infoTabAboutEl, infoState.tab === 'about');
  setTabButtonState(infoTabUserAgreementEl, infoState.tab === 'user-agreement');
  setTabButtonState(infoTabPrivacyPolicyEl, infoState.tab === 'privacy-policy');

  if (infoState.tab === 'user-agreement') await loadLegalDoc('user-agreement');
  if (infoState.tab === 'privacy-policy') await loadLegalDoc('privacy-policy');

  if (push) updateTabInUrl(false);
}

function renderBuildInfo() {
  if (infoBuildVersionEl) infoBuildVersionEl.textContent = BUILD_INFO_CONFIG.version;
  if (infoBuildShaEl) infoBuildShaEl.textContent = BUILD_INFO_CONFIG.shortSha;
  if (infoBuildRepoLinkEl) {
    infoBuildRepoLinkEl.href = BUILD_INFO_CONFIG.repoUrl;
    infoBuildRepoLinkEl.title = BUILD_INFO_CONFIG.repoUrl;
    infoBuildRepoLinkEl.textContent = t('infoTechRepoLinkText', null, 'github');
  }
}

function readInitialTabFromUrl() {
  try {
    const url = new URL(window.location.href);
    return getNormalizedTab(url.searchParams.get('tab'));
  } catch {
    return 'about';
  }
}

if (infoTabAboutEl) infoTabAboutEl.addEventListener('click', async () => setTab('about'));
if (infoTabUserAgreementEl) infoTabUserAgreementEl.addEventListener('click', async () => setTab('user-agreement'));
if (infoTabPrivacyPolicyEl) infoTabPrivacyPolicyEl.addEventListener('click', async () => setTab('privacy-policy'));

window.addEventListener('popstate', async () => {
  const nextTab = readInitialTabFromUrl();
  await setTab(nextTab, { push: false });
});

(async () => {
  applyInfoTexts();
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
      mapReturnMenuLinkEl
    });
  }
  renderBuildInfo();
  const initialTab = readInitialTabFromUrl();
  await setTab(initialTab, { push: false });
  updateTabInUrl(true);
})();
