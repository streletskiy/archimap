(function initPanelPageHelpers() {
  var LAST_MAP_HASH_STORAGE_KEY = 'archimap-last-map-hash';

  function getMapReturnHref() {
    try {
      var hash = String(localStorage.getItem(LAST_MAP_HASH_STORAGE_KEY) || '').trim();
      return hash.startsWith('#map=') ? '/' + hash : '/';
    } catch {
      return '/';
    }
  }

  function initMapReturnLinks(options) {
    var opts = options || {};
    var href = getMapReturnHref();
    if (opts.navLogoLinkEl) opts.navLogoLinkEl.setAttribute('href', href);
    if (opts.mapReturnLinkEl) opts.mapReturnLinkEl.setAttribute('href', href);
    if (opts.mapReturnMenuLinkEl) opts.mapReturnMenuLinkEl.setAttribute('href', href);
  }

  function setNavMenuOpen(navMenuButtonEl, navMenuPanelEl, open) {
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

  function initNavMenu(options) {
    var opts = options || {};
    var navMenuButtonEl = opts.navMenuButtonEl || null;
    var navMenuPanelEl = opts.navMenuPanelEl || null;
    if (!navMenuButtonEl || !navMenuPanelEl) return;
    setNavMenuOpen(navMenuButtonEl, navMenuPanelEl, false);

    navMenuButtonEl.addEventListener('click', function onMenuButtonClick(event) {
      event.stopPropagation();
      var expanded = navMenuButtonEl.getAttribute('aria-expanded') === 'true';
      setNavMenuOpen(navMenuButtonEl, navMenuPanelEl, !expanded);
    });

    document.addEventListener('click', function onDocumentClick(event) {
      if (!navMenuPanelEl.contains(event.target) && !navMenuButtonEl.contains(event.target)) {
        setNavMenuOpen(navMenuButtonEl, navMenuPanelEl, false);
      }
    });

    document.addEventListener('keydown', function onDocumentKeydown(event) {
      if (event.key === 'Escape') setNavMenuOpen(navMenuButtonEl, navMenuPanelEl, false);
    });
  }

  function initThemeToggle(options) {
    var opts = options || {};
    var themeToggleEl = opts.themeToggleEl || null;
    var onThemeChange = typeof opts.onThemeChange === 'function' ? opts.onThemeChange : null;
    if (!themeToggleEl || !onThemeChange) return;
    var current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    themeToggleEl.checked = current === 'dark';
    themeToggleEl.addEventListener('change', function onThemeToggleChange() {
      onThemeChange(themeToggleEl.checked ? 'dark' : 'light');
    });
  }

  window.ArchiMapPanelPage = {
    getMapReturnHref: getMapReturnHref,
    initMapReturnLinks: initMapReturnLinks,
    initNavMenu: initNavMenu,
    initThemeToggle: initThemeToggle
  };
})();
