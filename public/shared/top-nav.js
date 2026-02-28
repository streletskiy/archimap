(function initTopNavComponent() {
  var sharedT = window.ArchiMapTextUtils && typeof window.ArchiMapTextUtils.createTranslator === 'function'
    ? window.ArchiMapTextUtils.createTranslator('ui')
    : null;

  function t(key, fallback) {
    if (sharedT) return sharedT(key, null, fallback || '');
    return String(fallback || '');
  }

  function getUI() {
    return window.ArchiMapUI || null;
  }

  function renderToggle(options) {
    var ui = getUI();
    if (ui && typeof ui.renderToggle === 'function') {
      return ui.renderToggle(options);
    }
    return '';
  }

  function render(options) {
    var context = options && options.context ? options.context : 'index';
    var root = document.getElementById('top-nav-root');
    if (!root) return;

    var templates = window.ArchiMapTopNavTemplates || null;
    if (!templates || typeof templates.getIndexTemplate !== 'function' || typeof templates.getPanelTemplate !== 'function') {
      return;
    }

    var deps = { t: t, renderToggle: renderToggle };
    root.innerHTML = (context === 'account' || context === 'admin')
      ? templates.getPanelTemplate(context, options || {}, deps)
      : templates.getIndexTemplate(deps);
  }

  window.ArchiMapTopNav = { render: render };
})();
