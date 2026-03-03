<script>
  import { sidebarOpen } from '$lib/stores/ui';
  import { selectedBuilding } from '$lib/stores/map';
  import { openBuildingModal } from '$lib/stores/ui';
  import { t } from '$lib/i18n/index';

  $: hasSelection = Boolean($selectedBuilding);
</script>

<aside class:closed={!$sidebarOpen} class="panel">
  <h2>{$t('common.panels')}</h2>
  <p>
    {$t('panel.description')}
  </p>
  {#if hasSelection}
    <div class="card">
      <div class="label">{$t('panel.selected')}</div>
      <div class="value">{$selectedBuilding.osmType}/{$selectedBuilding.osmId}</div>
      <button type="button" class="ui-btn ui-btn-primary" on:click={openBuildingModal}>{$t('panel.openCard')}</button>
    </div>
  {:else}
    <p class="hint">{$t('panel.pickBuilding')}</p>
  {/if}
</aside>

<style>
  .panel {
    position: fixed;
    z-index: 35;
    top: 80px;
    right: 12px;
    width: min(360px, calc(100vw - 24px));
    max-height: calc(100vh - 92px);
    overflow: auto;
    padding: 16px;
    border: 1px solid #e2e8f0;
    border-radius: 1rem;
    background: color-mix(in srgb, var(--panel) 92%, transparent);
    backdrop-filter: blur(8px);
    box-shadow: 0 12px 30px rgb(15 23 42 / 0.12);
    transform: translateX(0);
    transition: transform 180ms ease;
  }

  .panel.closed {
    transform: translateX(calc(100% + 20px));
  }

  .hint,
  p {
    color: #64748b;
    line-height: 1.4;
  }

  .card {
    margin-top: 12px;
    padding: 12px;
    border: 1px solid #e2e8f0;
    border-radius: 0.75rem;
    background: #f8fafc;
    display: grid;
    gap: 8px;
  }

  .label {
    font-size: 12px;
    text-transform: uppercase;
    color: #64748b;
  }

  .value {
    font-weight: 700;
  }

  :global(.ui-btn) {
    width: fit-content;
    cursor: pointer;
  }
</style>
