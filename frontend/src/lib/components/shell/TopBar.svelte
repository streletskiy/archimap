<script>
  import { mapReady } from '$lib/stores/map';
  import { toggleSidebar } from '$lib/stores/ui';
  import { t } from '$lib/i18n/index';
</script>

<header class="topbar">
  <div class="brand">
    <strong>{$t('common.appName')}</strong>
    <span class="status">{$mapReady ? $t('common.ready') : $t('mapPage.mapLoading')}</span>
  </div>
  <button type="button" class="sidebar-toggle" on:click={() => toggleSidebar()}>
    {$t('common.panels')}
  </button>
</header>

<style>
  .topbar {
    position: fixed;
    z-index: 40;
    top: 12px;
    left: 12px;
    right: 12px;
    height: 56px;
    padding: 0 16px;
    border: 1px solid var(--panel-border);
    border-radius: 14px;
    background: color-mix(in srgb, var(--panel) 90%, transparent);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 10px 30px rgb(15 23 42 / 0.12);
  }

  .brand {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .status {
    font-size: 12px;
    color: var(--muted);
  }

  .sidebar-toggle {
    border: 1px solid var(--panel-border);
    background: #f8fafc;
    color: var(--fg);
    padding: 9px 14px;
    border-radius: 10px;
    cursor: pointer;
  }
</style>
