<script>
  import '../app.css';
  import AppHeader from '$lib/components/shell/AppHeader.svelte';
</script>

<svelte:head>
  <title>archimap app</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <script>
    (function applyInitialTheme() {
      const key = 'archimap-theme';
      let theme = 'light';
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
  </script>
  <script src="/app-config.js"></script>
</svelte:head>

<main class="page-shell">
  <AppHeader />
  <slot />
</main>

<style>
  .page-shell {
    min-height: 100vh;
  }
</style>
