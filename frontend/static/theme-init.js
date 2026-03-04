/* global window, document, localStorage */
(function applyInitialTheme() {
  var key = 'archimap-theme';
  var theme = 'light';
  try {
    var stored = localStorage.getItem(key);
    if (stored === 'light' || stored === 'dark') {
      theme = stored;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      theme = 'dark';
    }
  } catch {
    theme = 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
