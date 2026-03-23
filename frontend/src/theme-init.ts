(function applyInitialTheme() {
  const key = 'archimap-theme';
  let theme: 'light' | 'dark' = 'light';

  try {
    const stored = localStorage.getItem(key);
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
