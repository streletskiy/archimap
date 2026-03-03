<script>
  import { onMount } from 'svelte';
  import '../app.css';
  import AppHeader from '$lib/components/shell/AppHeader.svelte';
  import { initLocaleFromEnvironment, t } from '$lib/i18n/index';

  onMount(() => {
    initLocaleFromEnvironment();
  });
</script>

<svelte:head>
  <title>{$t('meta.appTitle')}</title>
  <meta name="description" content={$t('meta.appDescription')} />
  <meta property="og:title" content={$t('meta.appTitle')} />
  <meta property="og:description" content={$t('meta.appDescription')} />
  <script src="/theme-init.js"></script>
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
