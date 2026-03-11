<script>
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/stores';
  import BuildingModal from '$lib/components/shell/BuildingModal.svelte';
  import SearchModal from '$lib/components/shell/SearchModal.svelte';
  import { t } from '$lib/i18n/index';
  import { createBuildingDetailsManager } from '$lib/services/building-details-manager';
  import { createSearchManager } from '$lib/services/search-manager';
  import { createUrlStateManager } from '$lib/services/url-state-manager';
  import { buildingFilterLayers, resetBuildingFilterLayers, setBuildingFilterLayers } from '$lib/stores/filters';
  import { session } from '$lib/stores/auth';
  import { mapCenter, mapReady, mapZoom, requestMapFocus, selectedBuilding } from '$lib/stores/map';
  import { closeSearchModal } from '$lib/stores/search';
  import { buildingModalOpen } from '$lib/stores/ui';

  const buildingDetailsManager = createBuildingDetailsManager();
  const searchManager = createSearchManager();
  const urlStateManager = createUrlStateManager({
    pageStore: page,
    onApplyBuilding: (building) => buildingDetailsManager.selectBuilding(building),
    onClearBuildingSelection: () => buildingDetailsManager.clearSelection(),
    onApplyFilters: (filters) => setBuildingFilterLayers(filters),
    onClearFilters: () => resetBuildingFilterLayers()
  });

  let MapCanvasComponent = null;

  onMount(async () => {
    searchManager.start();
    const module = await import('$lib/components/map/MapCanvas.svelte');
    MapCanvasComponent = module.default;
  });

  onDestroy(() => {
    searchManager.destroy();
    urlStateManager.destroy();
    buildingDetailsManager.destroy();
  });

  function onBuildingClick(event) {
    buildingDetailsManager.selectBuilding(event?.detail);
  }

  async function onSelectSearchResult(event) {
    const item = event?.detail || {};
    if (!item?.osmType || !item?.osmId) return;
    if (Number.isFinite(Number(item?.lon)) && Number.isFinite(Number(item?.lat))) {
      requestMapFocus({
        lon: Number(item.lon),
        lat: Number(item.lat),
        offsetX: window.innerWidth >= 1024 ? -Math.round(window.innerWidth * 0.18) : 0,
        offsetY: 0,
        zoom: 16,
        duration: 450
      });
    }
    closeSearchModal();
    buildingDetailsManager.selectBuilding(item);
  }

  function closeBuildingSelection() {
    buildingDetailsManager.clearSelection();
    urlStateManager.handleManualBuildingClose({
      mapReady: $mapReady
    });
  }

  async function onSaveBuildingEdit(event) {
    await buildingDetailsManager.saveEdit(event?.detail);
  }

  $: {
    $page;
    $mapReady;
    urlStateManager.applyUrlStateToUi({
      mapReady: $mapReady,
      buildingModalOpen: $buildingModalOpen,
      selectedBuilding: $selectedBuilding,
      currentFilters: $buildingFilterLayers
    });
  }

  $: urlStateManager.syncBuildingSelection({
    mapReady: $mapReady,
    buildingModalOpen: $buildingModalOpen,
    selectedBuilding: $selectedBuilding
  });

  $: urlStateManager.syncCamera({
    mapReady: $mapReady,
    mapCenter: $mapCenter,
    mapZoom: $mapZoom
  });

  $: urlStateManager.syncFilters({
    currentFilters: $buildingFilterLayers
  });
</script>

{#if MapCanvasComponent}
  <svelte:component this={MapCanvasComponent} on:buildingClick={onBuildingClick} />
{:else}
  <div class="map-loading">{$t('mapPage.mapLoading')}</div>
{/if}
<BuildingModal
  buildingDetails={$buildingDetailsManager.buildingDetails}
  isAuthenticated={$session.authenticated}
  canEditBuildings={Boolean($session.user?.canEditBuildings || $session.user?.isAdmin)}
  savePending={$buildingDetailsManager.savePending}
  saveStatus={$buildingDetailsManager.saveStatus}
  on:save={onSaveBuildingEdit}
  on:close={closeBuildingSelection}
/>
<SearchModal on:selectResult={onSelectSearchResult} />

<style>
  .map-loading {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 0.95rem;
    color: #64748b;
    background: linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%);
  }
</style>
