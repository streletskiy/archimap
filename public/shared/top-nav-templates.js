(function initTopNavTemplates() {
  function getIndexTemplate(deps) {
      var t = deps.t;
      var renderToggle = deps.renderToggle;
      var authLoginText = t('authFabLogin', 'Войти');
      var adminPanelText = t('navAdminPanel', 'Админ-панель');
      var logoutText = t('navLogout', 'Выход');
      var themeText = t('navTheme', 'Тема');
      var labelsText = t('navLabels', 'Обозначения');
      var filterOpenText = t('filterPanelOpen', 'Открыть фильтр');
      var switchesOpenText = t('switchesPanelOpen', 'Открыть переключатели');
      var searchBuildingsText = t('searchBuildings', 'Поиск по зданиям');
      var filterTitleText = t('filterPanelTitle', 'Фильтр OSM тегов');
      var filterHintText = t('filterPanelHint', 'Критерии применяются к тегам OSM у загруженных зданий.');
      var addCriterionText = t('filterAddCriterion', '+ Критерий');
      var resetText = t('filterReset', 'Сброс');
      var closeText = t('commonClose', 'Закрыть');
      var searchPlaceholder = t('searchPlaceholder', 'Поиск: название, адрес, стиль, архитектор');
      var labelsAria = t('labelsHide', 'Скрыть обозначения карты');
      var themeAria = t('themeEnableDark', 'Переключить тему');
  
      var labelsToggle = renderToggle({
        id: 'labels-toggle',
        ariaLabel: labelsAria,
        checkedColorClass: 'peer-checked:bg-indigo-500',
        checkedKnobClass: 'peer-checked:bg-indigo-50',
        checkedIconClass: 'peer-checked:text-indigo-700',
        withIcons: true,
        kind: 'labels',
        wrapperClass: 'relative inline-flex h-10 w-[76px] cursor-pointer items-center rounded-full bg-white px-2 shadow-soft hover:bg-slate-50'
      });
  
      var themeToggle = renderToggle({
        id: 'theme-toggle',
        ariaLabel: themeAria,
        checkedColorClass: 'peer-checked:bg-indigo-500',
        checkedKnobClass: 'peer-checked:bg-indigo-50',
        checkedIconClass: 'peer-checked:text-white',
        withIcons: true,
        kind: 'theme'
      });
  
      return `
    <div id="navigation" class="fixed inset-x-0 top-0 z-[930] px-3 pt-3 sm:px-4 sm:pt-4">
      <div class="relative rounded-2xl border border-slate-300 bg-white/95 px-3 py-2 shadow-float backdrop-blur">
        <div class="flex items-center justify-between gap-1">
          <div class="flex min-w-0 items-center gap-2">
            <a id="nav-logo-link" href="/" class="inline-flex h-10 select-none items-center px-2 text-2xl font-extrabold tracking-tight text-black sm:text-xl">/archimap</a>
            <button id="filter-toggle-btn" type="button" class="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-800 transition-colors hover:bg-slate-50" aria-label="${filterOpenText}" aria-expanded="false">
              <svg viewBox="0 0 512 512" width="15" height="15" aria-hidden="true" class="fill-current"><path d="M3.9 54.9C10.5 40.9 24.5 32 40 32l432 0c15.5 0 29.5 8.9 36.1 22.9s4.6 30.5-5.2 42.5L320 320.9 320 448c0 12.1-6.8 23.2-17.7 28.6s-23.8 4.3-33.5-3l-64-48c-8.1-6-12.8-15.5-12.8-25.6l0-79.1L9 97.3C-.7 85.4-2.8 68.8 3.9 54.9z"></path></svg>
            </button>
            <button id="search-mobile-btn" type="button" class="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-800 transition-colors hover:bg-slate-50 sm:hidden" aria-label="${searchBuildingsText}">
              <svg viewBox="0 0 640 640" width="16" height="16" aria-hidden="true" class="fill-current"><path d="M480 272C480 317.9 465.1 360.3 440 394.7L566.6 521.4C579.1 533.9 579.1 554.2 566.6 566.7C554.1 579.2 533.8 579.2 521.3 566.7L394.7 440C360.3 465.1 317.9 480 272 480C157.1 480 64 386.9 64 272C64 157.1 157.1 64 272 64C386.9 64 480 157.1 480 272zM272 416C351.5 416 416 351.5 416 272C416 192.5 351.5 128 272 128C192.5 128 128 192.5 128 272C128 351.5 192.5 416 272 416z"></path></svg>
            </button>
          </div>
          <form id="search-form" class="mx-1 hidden min-w-0 flex-1 sm:block">
            <label for="search-input" class="group flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 shadow-soft transition focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-200">
              <svg viewBox="0 0 640 640" width="15" height="15" aria-hidden="true" class="fill-current text-slate-500 transition group-focus-within:text-indigo-600"><path d="M480 272C480 317.9 465.1 360.3 440 394.7L566.6 521.4C579.1 533.9 579.1 554.2 566.6 566.7C554.1 579.2 533.8 579.2 521.3 566.7L394.7 440C360.3 465.1 317.9 480 272 480C157.1 480 64 386.9 64 272C64 157.1 157.1 64 272 64C386.9 64 480 157.1 480 272zM272 416C351.5 416 416 351.5 416 272C416 192.5 351.5 128 272 128C192.5 128 128 192.5 128 272C128 351.5 192.5 416 272 416z"></path></svg>
              <input id="search-input" type="search" placeholder="${searchPlaceholder}" class="h-full w-full border-0 bg-transparent text-sm text-slate-900 placeholder:text-slate-500 focus:outline-none" autocomplete="off" />
            </label>
          </form>
          <div class="flex items-center gap-2">
            <button id="mobile-controls-toggle-btn" type="button" class="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-800 transition-colors hover:bg-slate-50" aria-label="${switchesOpenText}" aria-expanded="false">
              <svg viewBox="0 0 640 640" width="24" height="24" aria-hidden="true" class="fill-current"><path d="M96 160C96 142.3 110.3 128 128 128L512 128C529.7 128 544 142.3 544 160C544 177.7 529.7 192 512 192L128 192C110.3 192 96 177.7 96 160zM96 320C96 302.3 110.3 288 128 288L512 288C529.7 288 544 302.3 544 320C544 337.7 529.7 352 512 352L128 352C110.3 352 96 337.7 96 320zM544 480C544 497.7 529.7 512 512 512L128 512C110.3 512 96 497.7 96 480C96 462.3 110.3 448 128 448L512 448C529.7 448 544 462.3 544 480z"></path></svg>
            </button>
            <div id="mobile-controls-shell" class="pointer-events-none absolute right-0 top-[calc(100%+0.375rem)] sm:top-[calc(100%+0.75rem)] z-[960] flex w-64 flex-col gap-2 rounded-xl border border-slate-300 bg-white/95 p-2 shadow-soft transition-all duration-200 ease-out origin-top-right max-h-0 -translate-y-2 scale-95 overflow-hidden opacity-0">
              <a id="auth-fab" href="/?auth=1&next=%2F" class="block rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100" aria-label="${authLoginText}">${authLoginText}</a>
              <a id="admin-link" href="/admin/" class="hidden rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">${adminPanelText}</a>
              <button id="settings-logout-btn" type="button" class="hidden rounded-[16px] bg-rose-500 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-600">${logoutText}</button>
              <div class="my-1 border-t border-slate-200"></div>
              <div class="space-y-1">
                <div class="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1"><span class="text-sm font-semibold text-slate-700">${themeText}</span>${themeToggle}</div>
                <div class="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1"><span class="text-sm font-semibold text-slate-700">${labelsText}</span>${labelsToggle}</div>
              </div>
              <a id="settings-build-link" href="https://github.com/streletskiy/archimap" target="_blank" rel="noopener noreferrer" class="block w-full rounded-lg px-2 py-1 text-center text-[11px] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"><span id="settings-build-text">unknown | dev | archimap</span></a>
            </div>
          </div>
        </div>
        <div id="filter-shell" class="absolute left-0 top-[calc(100%+0.5rem)] w-[360px] max-w-[calc(100vw-1.5rem)] rounded-xl border border-slate-300 bg-white/95 p-3 shadow-soft transition-all duration-200 ease-out origin-top-left max-h-0 -translate-y-2 scale-95 overflow-hidden opacity-0 pointer-events-none">
          <div id="filter-panel">
            <div class="mb-3 flex items-center justify-between"><h3 class="text-base font-extrabold text-slate-900">${filterTitleText}</h3><button id="filter-close-btn" type="button" class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label="${closeText}">✕</button></div>
            <p class="mb-3 text-xs text-slate-600">${filterHintText}</p>
            <form id="filter-form" class="space-y-3"><div id="filter-rows" class="space-y-2"></div><div class="flex items-center gap-2"><button id="filter-add-row-btn" type="button" class="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">${addCriterionText}</button><button id="filter-reset-btn" type="button" class="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">${resetText}</button></div></form>
            <p id="filter-status" class="mt-3 text-xs text-slate-600">${t('filterInactive', 'Фильтр не активен.')}</p>
            <datalist id="filter-tag-keys"></datalist>
          </div>
        </div>
      </div>
    </div>`;
    }

  function getPanelTemplate(mode, options, deps) {
      var t = deps.t;
      var renderToggle = deps.renderToggle;
      var opts = options || {};
      var isAdmin = mode === 'admin';
      var showMapLink = opts.showMapLink !== false;
      var profileText = t('authFabProfile', 'Профиль');
      var backToMapText = t('navBackToMap', 'Вернуться на карту');
      var adminPanelText = t('navAdminPanel', 'Админ-панель');
      var logoutText = t('navLogout', 'Выход');
      var themeText = t('navTheme', 'Тема');
      var openMenuText = t('navOpenMenu', 'Открыть меню');
      var activeAdmin = mode === 'admin' ? ' bg-slate-100' : '';
      var adminLinkClass = isAdmin ? 'block' : 'hidden block';
      var profileLink = mode === 'account'
        ? '<a id="auth-fab" href="/account/" class="block rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-900">' + profileText + '</a>'
        : '<a id="auth-fab" href="/account/" class="block rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">' + profileText + '</a>';
      var mapLink = showMapLink
        ? '<a id="map-return-menu-link" href="/" class="block rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">' + backToMapText + '</a>'
        : '';
      var themeToggle = renderToggle({
        id: 'theme-toggle',
        ariaLabel: 'Переключить тему',
        checkedColorClass: 'peer-checked:bg-indigo-500',
        checkedKnobClass: 'peer-checked:bg-indigo-50',
        checkedIconClass: 'peer-checked:text-white',
        withIcons: true,
        kind: 'theme'
      });
  
      return `
    <div id="navigation" class="fixed inset-x-0 top-0 z-[930] px-3 pt-3 sm:px-4 sm:pt-4">
      <div class="relative rounded-2xl border border-slate-300 bg-white/95 px-3 py-2 shadow-soft backdrop-blur-sm">
        <div class="flex items-center justify-between gap-3">
          <div class="flex min-w-0 items-center px-2">
            <a id="nav-logo-link" href="/" class="inline-flex h-10 select-none items-center text-2xl font-extrabold tracking-tight text-black sm:text-xl">/archimap</a>
          </div>
          <div class="flex items-center gap-2">
            <button id="nav-menu-button" type="button" class="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50" aria-label="${openMenuText}" aria-expanded="false"><svg viewBox="0 0 640 640" width="24" height="24" aria-hidden="true" class="fill-current"><path d="M96 160C96 142.3 110.3 128 128 128L512 128C529.7 128 544 142.3 544 160C544 177.7 529.7 192 512 192L128 192C110.3 192 96 177.7 96 160zM96 320C96 302.3 110.3 288 128 288L512 288C529.7 288 544 302.3 544 320C544 337.7 529.7 352 512 352L128 352C110.3 352 96 337.7 96 320zM544 480C544 497.7 529.7 512 512 512L128 512C110.3 512 96 497.7 96 480C96 462.3 110.3 448 128 448L512 448C529.7 448 544 462.3 544 480z"></path></svg></button>
          </div>
        </div>
        <div id="nav-menu-panel" class="pointer-events-none absolute right-0 top-[calc(100%+0.375rem)] sm:top-[calc(100%+0.75rem)] z-[960] flex w-64 flex-col gap-2 rounded-xl border border-slate-300 bg-white/95 p-2 shadow-soft transition-all duration-200 ease-out origin-top-right max-h-0 -translate-y-2 scale-95 overflow-hidden opacity-0">
          ${profileLink}
          ${mapLink}
          <a id="admin-link" href="/admin/" class="${adminLinkClass + activeAdmin} rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">${adminPanelText}</a>
          <button id="settings-logout-btn" type="button" class="hidden rounded-[16px] bg-rose-500 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-600">${logoutText}</button>
          <div class="my-2 border-t border-slate-200"></div>
          <div class="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1"><span class="text-sm font-semibold text-slate-700">${themeText}</span>${themeToggle}</div>
          <a id="settings-build-link" href="https://github.com/streletskiy/archimap" target="_blank" rel="noopener noreferrer" class="mt-1 block w-full rounded-lg px-2 py-1 text-center text-[11px] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"><span id="settings-build-text">unknown | dev | archimap</span></a>
        </div>
      </div>
    </div>`;
    }

  window.ArchiMapTopNavTemplates = {
    getIndexTemplate: getIndexTemplate,
    getPanelTemplate: getPanelTemplate
  };
})();

