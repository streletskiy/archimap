(function initArchiMapTextUtils() {
  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function createTranslator(scope) {
    const dictRoot = window.__ARCHIMAP_I18N_RU || {};
    const dict = dictRoot && typeof dictRoot === 'object' && dictRoot[scope] && typeof dictRoot[scope] === 'object'
      ? dictRoot[scope]
      : {};

    return function t(key, params = null, fallback = '') {
      const template = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : fallback;
      const base = String(template || fallback || '');
      if (!params || typeof params !== 'object') return base;
      return base.replace(/\{(\w+)\}/g, (_, name) => (params[name] == null ? '' : String(params[name])));
    };
  }

  function createUiTextTools() {
    return {
      t: createTranslator('ui'),
      escapeHtml
    };
  }

  window.ArchiMapTextUtils = {
    escapeHtml,
    createTranslator,
    createUiTextTools
  };
})();
