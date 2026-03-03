<script>
  import '../app.css';
  import AppHeader from '$lib/components/shell/AppHeader.svelte';
</script>

<svelte:head>
  <title>archimap app</title>
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
