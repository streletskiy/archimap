<script>
  import { beforeNavigate } from '$app/navigation';
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { CUSTOM_MAP_ATTRIBUTION } from '$lib/constants/map';
  import { getRuntimeConfig } from '$lib/services/config';
  import MapFeedbackOverlay from '$lib/components/map/MapFeedbackOverlay.svelte';
  import { createMapDebugController } from '$lib/services/map/map-debug';
  import {
    createFilterPipeline,
    FILTER_HIGHLIGHT_MODE,
    FILTER_TELEMETRY_ENABLED
  } from '$lib/services/map/map-filter-pipeline';
  import {
    getFilterApplyOverlayState,
    shouldShowFilterApplyOverlay,
    shouldShowFilterRefiningMessage
  } from '$lib/services/map/filter-overlay-utils';
  import {
    applyBuildingThemePaint as applyBuildingThemePaintToLayers,
    applyBuildingPartsLayerVisibility as applyBuildingPartsLayerVisibilityToLayers,
    applyLabelLayerVisibility as applyMapLabelLayerVisibility,
    bindMapInteractionHandlers,
    getCurrentBuildingsFillLayerIds,
    getCurrentBuildingsLineLayerIds,
    getCurrentBuildingPartFillLayerIds,
    getCurrentBuildingPartLineLayerIds,
    getCurrentBuildingPartFilterHighlightFillLayerIds,
    getCurrentBuildingPartFilterHighlightLineLayerIds,
    getCurrentBuildingHoverFillLayerIds,
    getCurrentBuildingHoverLineLayerIds
  } from '$lib/services/map/map-layer-utils';
  import {
    fitMapToSearchResults as fitMapToSearchItems,
    updateSearchMarkers as updateSearchMarkerSource
  } from '$lib/services/map/map-search-utils';
  import {
    getCurrentTheme,
    getMapStyleForTheme,
    LIGHT_MAP_STYLE_URL,
    STYLE_OVERLAY_FADE_MS
  } from '$lib/services/map/map-theme-utils';
  import { loadMapRuntime } from '$lib/services/map-runtime';
  import { t, translateNow } from '$lib/i18n/index';
  import {
    lastMapCamera,
    mapFocusRequest,
    mapLabelsVisible,
    mapBuildingPartsVisible,
    mapZoom,
    setMapSelectionShiftKey,
    normalizeOptionalMapZoom,
    resolveInitialMapCamera,
    selectedBuilding,
    selectedBuildings,
    setMapCenter,
    setMapReady,
    setMapViewport,
    setMapZoom
  } from '$lib/stores/map';
  import { buildingFilterLayers, buildingFilterRuntime, setBuildingFilterRuntimeStatus } from '$lib/stores/filters';
  import { searchMapState, searchState } from '$lib/stores/search';
  import { createMapRegionLayersController } from './map-region-layers-controller';
  import { createMapSelectionController } from './map-selection-controller';
  import { buildBboxSnapshot } from './filter-pipeline-utils';

  const FILTER_APPLY_PROGRESS_TICK_MS = 120;

  const dispatch = createEventDispatcher();

  let container;
  let map = null;
  let maplibregl = null;
  let protocol = null;
  let themeObserver = null;
  let lastSelectedKey;
  let lastSearchFitSeq;
  let searchFitSeqInitialized = false;
  let lastMapFocusRequestId;
  let currentMapStyleUrl = LIGHT_MAP_STYLE_URL;
  let runtimeConfig = null;
  let styleTransitionOverlaySrc = null;
  let styleTransitionOverlayVisible = false;
  let styleTransitionTimer = null;
  let stopBuildingFilterLayers = null;
  let currentBuildingFilterLayers = [];
  let filterStatusOverlayText;
  let filterApplyClock = Date.now();
  let filterApplyClockTimer = null;
  let filterApplyVisible = false;
  let currentMapZoom = Number.NaN;
  let filterApplyOverlayState = {
    visible: false,
    progress: 0
  };
  let cameraStoreSyncEnabled = false;

  beforeNavigate((navigation) => {
    if (typeof window === 'undefined') return;
    const nextPathname = String(navigation?.to?.url?.pathname || '').trim();
    if (!nextPathname) {
      cameraStoreSyncEnabled = false;
      return;
    }
    if (nextPathname !== window.location.pathname) {
      cameraStoreSyncEnabled = false;
    }
  });

  onMount(() => {
    const setShiftKeyState = (value) => {
      setMapSelectionShiftKey(value);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Shift') setShiftKeyState(true);
    };
    const handleKeyUp = (event) => {
      if (event.key === 'Shift') setShiftKeyState(false);
    };
    const resetShiftKey = () => setShiftKeyState(false);

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', resetShiftKey);
    document.addEventListener('visibilitychange', resetShiftKey);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', resetShiftKey);
      document.removeEventListener('visibilitychange', resetShiftKey);
      setShiftKeyState(false);
    };
  });

  function getFilterStatusOverlayText(statusCode, zoom = currentMapZoom) {
    const code = String(statusCode || 'idle');
    if (code === 'refining' && shouldShowFilterRefiningMessage(code, zoom)) {
      return $t('mapPage.filterStatus.refining') || $t('header.filterStatus.refining');
    }
    if (code === 'too_many_matches') return $t('mapPage.filterStatus.tooMany') || $t('header.filterStatus.tooMany');
    if (code === 'truncated') return $t('mapPage.filterStatus.truncated') || $t('header.filterStatus.truncated');
    if (code === 'invalid') return $t('mapPage.filterStatus.invalid') || $t('header.filterStatus.invalid');
    return '';
  }

  $: currentMapZoom = Number($mapZoom ?? map?.getZoom?.() ?? Number.NaN);
  $: filterStatusOverlayText = getFilterStatusOverlayText($filterState.statusCode, currentMapZoom);
  $: filterApplyOverlayState = getFilterApplyOverlayState($filterState, $buildingFilterRuntime, filterApplyClock, currentMapZoom);
  $: filterApplyVisible = shouldShowFilterApplyOverlay($filterState, currentMapZoom);
  $: if (typeof window !== 'undefined') {
    if (filterApplyVisible && !filterApplyClockTimer) {
      filterApplyClockTimer = window.setInterval(() => {
        filterApplyClock = Date.now();
      }, FILTER_APPLY_PROGRESS_TICK_MS);
    } else if (!filterApplyVisible && filterApplyClockTimer) {
      clearInterval(filterApplyClockTimer);
      filterApplyClockTimer = null;
    }
  }

  function isSelectionDebugEnabled() {
    const fromRuntimeConfig = Boolean(runtimeConfig?.mapSelection?.debug);
    return Boolean(fromRuntimeConfig || import.meta.env.DEV);
  }

  function debugSelectionLog(eventName, payload = {}) {
    if (!isSelectionDebugEnabled()) return;
    console.debug('[map-selection]', eventName, {
      ts: new Date().toISOString(),
      ...payload
    });
  }

  function isFilterDebugEnabled() {
    return Boolean(import.meta.env.DEV || import.meta.env.MODE === 'test');
  }

  function recordDebugSetFilter(layerId) {
    mapDebug.recordSetFilter(layerId);
  }

  function getSelectionSignature(selection = []) {
    return (Array.isArray(selection) ? selection : [])
      .map((item) => `${String(item?.osmType || '').trim()}/${Number(item?.osmId) || ''}`)
      .filter((item) => item !== '/')
      .join('|');
  }

  const regionLayersController = createMapRegionLayersController({
    getMap: () => map,
    getRuntimeConfig: () => runtimeConfig,
    getCurrentTheme,
    getSearchItems: () => $searchMapState.items,
    getSelectedBuilding: () => (
      Array.isArray($selectedBuildings) && $selectedBuildings.length > 0
        ? $selectedBuildings
        : ($selectedBuilding?.osmType && $selectedBuilding?.osmId ? [$selectedBuilding] : [])
    ),
    getMapLabelsVisible: () => $mapLabelsVisible,
    getBuildingPartsVisible: () => $mapBuildingPartsVisible,
    getBuildingFilterLayers: () => currentBuildingFilterLayers,
    getWindowOrigin: () => window.location.origin,
    onBindStyleInteractionHandlers: () => bindStyleInteractionHandlers(),
    onApplySelectionFromStore: (selection) => selectionController.applySelectionFromStore(selection),
    onUpdateSearchMarkers: (items) => updateSearchMarkers(items),
    onApplyBuildingThemePaint: (theme) => applyBuildingThemePaint(theme),
    onApplyLabelLayerVisibility: (visible) => applyLabelLayerVisibility(visible),
    onApplyBuildingPartsLayerVisibility: () => applyBuildingPartsLayerVisibility($mapBuildingPartsVisible, {
      forceHighlightVisible: currentBuildingFilterLayers.length > 0
    }),
    onRefreshHoverFromPointer: () => selectionController.refreshHoverFromLastPointer(),
    onRefreshFilterDebugState: (active) => filterPipeline.refreshDebugState(active),
    onReapplyFilteredHighlight: () => filterPipeline.reapplyFilteredHighlight()
  });

  const mapDebug = createMapDebugController({
    getMap: () => map,
    getLayerIds: () => regionLayersController.getAllCurrentMapLayerIds(),
    isFilterDebugEnabled,
    telemetryEnabled: FILTER_TELEMETRY_ENABLED
  });

  const filterPipeline = createFilterPipeline({
    map: () => map,
    mapDebug,
    getLayerIds: () => regionLayersController.getCurrentMapLayerIds(),
    getBuildingSourceConfigs: () => regionLayersController.getCurrentBuildingSourceConfigs(),
    onStatusChange: setBuildingFilterRuntimeStatus,
    translateInvalidMessage: () => translateNow('mapPage.filterStatus.invalid')
  });

  stopBuildingFilterLayers = buildingFilterLayers.subscribe((layers) => {
    currentBuildingFilterLayers = Array.isArray(layers) ? layers : [];
    if (map) {
      filterPipeline.scheduleFilterRulesRefresh(currentBuildingFilterLayers);
    }
  });

  const selectionController = createMapSelectionController({
    getMap: () => map,
    getActiveRegions: () => regionLayersController.getActiveRegionPmtiles(),
    recordDebugSetFilter,
    debugSelectionLog,
    dispatchBuildingClick: (payload) => dispatch('buildingClick', payload)
  });

  const handleBuildingClick = (event) => selectionController.handleMapBuildingClick(event);
  const handleSearchClusterClick = (event) => selectionController.onSearchClusterClick(event);
  const handleSearchResultClick = (event) => selectionController.onSearchResultClick(event);
  const handleMapPointerMove = (event) => selectionController.handleMapPointerMove(event);
  const handleMapPointerLeave = () => selectionController.handleMapPointerLeave();

  const filterState = filterPipeline.state;

  function updateSearchMarkers(items) {
    updateSearchMarkerSource(map, items);
  }

  function fitMapToSearchResults(items) {
    fitMapToSearchItems(map, items);
  }

  function syncMapCameraStores() {
    if (!map || !cameraStoreSyncEnabled) return;
    setMapCenter(map.getCenter());
    setMapZoom(map.getZoom());
    setMapViewport(buildBboxSnapshot(map.getBounds?.()));
  }

  function syncMapZoomStore() {
    if (!map || !cameraStoreSyncEnabled) return;
    setMapZoom(map.getZoom());
  }

  function applyBuildingThemePaint(theme) {
    const activeRegions = regionLayersController.getActiveRegionPmtiles();
    applyBuildingThemePaintToLayers({
      map,
      theme,
      fillLayerIds: getCurrentBuildingsFillLayerIds(activeRegions),
      lineLayerIds: getCurrentBuildingsLineLayerIds(activeRegions),
      partFillLayerIds: getCurrentBuildingPartFillLayerIds(activeRegions),
      partLineLayerIds: getCurrentBuildingPartLineLayerIds(activeRegions),
      hoverFillLayerIds: getCurrentBuildingHoverFillLayerIds(activeRegions),
      hoverLineLayerIds: getCurrentBuildingHoverLineLayerIds(activeRegions)
    });
  }

  function applyBuildingPartsLayerVisibility(visible = $mapBuildingPartsVisible, { forceHighlightVisible = false } = {}) {
    const activeRegions = regionLayersController.getActiveRegionPmtiles();
    applyBuildingPartsLayerVisibilityToLayers({
      map,
      visible,
      forceHighlightVisible,
      partFillLayerIds: getCurrentBuildingPartFillLayerIds(activeRegions),
      partLineLayerIds: getCurrentBuildingPartLineLayerIds(activeRegions),
      partFilterHighlightFillLayerIds: getCurrentBuildingPartFilterHighlightFillLayerIds(activeRegions),
      partFilterHighlightLineLayerIds: getCurrentBuildingPartFilterHighlightLineLayerIds(activeRegions)
    });
  }

  function clearStyleTransitionOverlaySoon() {
    if (styleTransitionTimer) {
      clearTimeout(styleTransitionTimer);
      styleTransitionTimer = null;
    }
    styleTransitionOverlayVisible = false;
    styleTransitionTimer = setTimeout(() => {
      styleTransitionOverlaySrc = null;
      styleTransitionTimer = null;
    }, STYLE_OVERLAY_FADE_MS);
  }

  function captureStyleTransitionOverlay() {
    if (!map) return;
    try {
      const canvas = map.getCanvas();
      if (!canvas || typeof canvas.toDataURL !== 'function') return;
      styleTransitionOverlaySrc = canvas.toDataURL('image/png');
      styleTransitionOverlayVisible = true;
    } catch {
      styleTransitionOverlaySrc = null;
      styleTransitionOverlayVisible = false;
    }
  }

  function bindStyleInteractionHandlers() {
    bindMapInteractionHandlers({
      map,
      onBuildingClick: handleBuildingClick,
      onSearchClusterClick: handleSearchClusterClick,
      onSearchResultClick: handleSearchResultClick
    });
  }

  function applyLabelLayerVisibility(visible) {
    applyMapLabelLayerVisibility(map, visible);
  }

  function restoreCustomLayersAfterStyleChange() {
    if (!map || !runtimeConfig) return;
    const tryRestore = () => {
      if (!map || !runtimeConfig) return;
      if (!map.isStyleLoaded()) return;
      regionLayersController.ensureMapSourcesAndLayers(runtimeConfig, { force: true });
      filterPipeline.applyBuildingFilters(currentBuildingFilterLayers, { reason: 'style' });
      clearStyleTransitionOverlaySoon();
    };
    map.once('styledata', tryRestore);
    map.once('idle', tryRestore);
  }

  function applyThemeToMap(theme) {
    if (!map) return;
    const nextStyle = getMapStyleForTheme(theme);
    if (nextStyle === currentMapStyleUrl) return;
    captureStyleTransitionOverlay();
    currentMapStyleUrl = nextStyle;
    map.setStyle(nextStyle);
    restoreCustomLayersAfterStyleChange();
  }

  $: {
    const currentSelection = Array.isArray($selectedBuildings) && $selectedBuildings.length > 0
      ? $selectedBuildings
      : ($selectedBuilding?.osmType && $selectedBuilding?.osmId ? [$selectedBuilding] : []);
    if (!map) {
      void lastSelectedKey;
    } else if (currentSelection.length === 0) {
      lastSelectedKey = null;
      selectionController.clearSelectedFeature();
      void lastSelectedKey;
    } else {
      const key = getSelectionSignature(currentSelection);
      if (key !== lastSelectedKey) {
        lastSelectedKey = key;
        selectionController.applySelectionFromStore(currentSelection);
      }
      void lastSelectedKey;
    }
  }

  $: if (map) {
    updateSearchMarkers($searchMapState.items);
  }

  $: if (map) {
    if (!searchFitSeqInitialized) {
      searchFitSeqInitialized = true;
      lastSearchFitSeq = $searchState.fitSeq;
      if (lastSearchFitSeq) {
        fitMapToSearchResults($searchState.items);
      }
    } else if ($searchState.fitSeq !== lastSearchFitSeq) {
      lastSearchFitSeq = $searchState.fitSeq;
      fitMapToSearchResults($searchState.items);
    }
    void searchFitSeqInitialized;
    void lastSearchFitSeq;
  }

  $: if (map && $mapFocusRequest && $mapFocusRequest.id !== lastMapFocusRequestId) {
    lastMapFocusRequestId = $mapFocusRequest.id;
    const nextZoom = normalizeOptionalMapZoom($mapFocusRequest.zoom) ?? map.getZoom();
    map.easeTo({
      center: [Number($mapFocusRequest.lon), Number($mapFocusRequest.lat)],
      offset: [Number($mapFocusRequest.offsetX || 0), Number($mapFocusRequest.offsetY || 0)],
      zoom: nextZoom,
      duration: Number($mapFocusRequest.duration || 420),
      essential: true
    });
    void lastMapFocusRequestId;
  }

  $: if (map) {
    applyLabelLayerVisibility($mapLabelsVisible);
  }

  $: if (map) {
    const buildingPartsVisible = $mapBuildingPartsVisible;
    const forceHighlightVisible = Array.isArray($buildingFilterLayers) && $buildingFilterLayers.length > 0;
    applyBuildingPartsLayerVisibility(buildingPartsVisible, { forceHighlightVisible });
    filterPipeline.reapplyFilteredHighlight();
  }

  onMount(() => {
    let mountAlive = true;
    async function initMap() {
      const { maplibregl: maplibreModule, Protocol: ProtocolCtor } = await loadMapRuntime();
      if (!mountAlive) return;
      maplibregl = maplibreModule;

      const config = getRuntimeConfig();
      runtimeConfig = config;
      protocol = new ProtocolCtor();
      maplibregl.addProtocol('pmtiles', protocol.tile);
      currentMapStyleUrl = getMapStyleForTheme(getCurrentTheme());
      const initialCamera = resolveInitialMapCamera({
        url: window.location.href,
        persistedCamera: get(lastMapCamera),
        fallbackCamera: {
          lng: config.mapDefault.lon,
          lat: config.mapDefault.lat,
          z: config.mapDefault.zoom
        }
      }) || {
        lng: Number(config.mapDefault.lon),
        lat: Number(config.mapDefault.lat),
        z: Number(config.mapDefault.zoom)
      };
      setMapCenter({
        lng: initialCamera.lng,
        lat: initialCamera.lat
      });
      setMapZoom(initialCamera.z);

      map = new maplibregl.Map({
        container,
        style: currentMapStyleUrl,
        center: [initialCamera.lng, initialCamera.lat],
        zoom: Number(initialCamera.z),
        attributionControl: false
      });
      // Reserve Shift+Click for bulk building selection on the main map surface.
      map.boxZoom?.disable?.();
      map.addControl(new maplibregl.AttributionControl({
        compact: true,
        customAttribution: CUSTOM_MAP_ATTRIBUTION
      }));
      map.addControl(new maplibregl.NavigationControl(), 'top-right');
      map.on('moveend', () => {
        filterPipeline.registerFilterMoveEnd();
        syncMapCameraStores();
        regionLayersController.syncMapRegionSources();
      });
      map.on('moveend', () => filterPipeline.scheduleFilterRefresh(currentBuildingFilterLayers));
      map.on('moveend', () => regionLayersController.scheduleCoverageCheck());
      map.on('move', () => regionLayersController.scheduleCoverageCheck());
      map.on('zoomend', () => filterPipeline.scheduleFilterRefresh(currentBuildingFilterLayers));
      map.on('zoomend', syncMapZoomStore);
      map.on('zoomend', () => regionLayersController.syncMapRegionSources());
      map.on('zoomend', () => regionLayersController.scheduleCoverageCheck());
      map.on('resize', () => regionLayersController.syncMapRegionSources());
      map.on('resize', () => regionLayersController.scheduleCoverageCheck());
      map.on('mousemove', handleMapPointerMove);
      map.on('mouseleave', handleMapPointerLeave);
      map.on('mouseout', handleMapPointerLeave);

      map.on('style.load', () => {
        regionLayersController.ensureMapSourcesAndLayers(config, { force: true });
        filterPipeline.scheduleFilterRefresh(currentBuildingFilterLayers);
        regionLayersController.scheduleCoverageCheck();
      });

      map.on('load', () => {
        cameraStoreSyncEnabled = true;
        filterPipeline.registerFilterMoveEnd();
        syncMapCameraStores();
        regionLayersController.syncMapRegionSources();
        setMapReady(true);
        filterPipeline.scheduleFilterRulesRefresh(currentBuildingFilterLayers);
        regionLayersController.scheduleCoverageCheck();
      });

      themeObserver = new MutationObserver(() => {
        applyThemeToMap(getCurrentTheme());
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme']
      });
    }

    initMap().catch(() => {
      // Keep empty fallback state if map runtime cannot initialize.
    });

    return () => {
      mountAlive = false;
    };
  });

  onDestroy(() => {
    stopBuildingFilterLayers?.();
    stopBuildingFilterLayers = null;
    cameraStoreSyncEnabled = false;
    setMapReady(false);
    setMapCenter(null);
    setMapZoom(null);
    setMapViewport(null);
    if (themeObserver) {
      themeObserver.disconnect();
      themeObserver = null;
    }
    if (styleTransitionTimer) {
      clearTimeout(styleTransitionTimer);
      styleTransitionTimer = null;
    }
    if (filterApplyClockTimer) {
      clearInterval(filterApplyClockTimer);
      filterApplyClockTimer = null;
    }
    selectionController.destroy();
    regionLayersController.destroy();
    filterPipeline.destroy();
    if (map) {
      map.remove();
      map = null;
    }
    runtimeConfig = null;
    if (protocol) {
      protocol?.destroy?.();
      protocol = null;
    }
  });
</script>

<div
  class="map-canvas"
  bind:this={container}
  data-filter-active={$filterState.debugActive ? 'true' : 'false'}
  data-filter-highlight-mode={FILTER_HIGHLIGHT_MODE}
  data-filter-expr-hash={$filterState.debugExprHash}
  data-filter-phase={$filterState.phase}
  data-filter-last-elapsed-ms={String($filterState.lastElapsedMs)}
  data-filter-last-count={String($filterState.lastCount)}
  data-filter-cache-hit={$filterState.lastCacheHit ? 'true' : 'false'}
  data-filter-set-paint-property-calls={String($filterState.setPaintPropertyCallsLast)}
  data-filter-last-paint-apply-ms={String($filterState.lastPaintApplyMs)}
></div>
<MapFeedbackOverlay
  filterStatusCode={$filterState.statusCode}
  {filterStatusOverlayText}
  filterErrorMessage={$filterState.errorMessage}
  filterApplyVisible={filterApplyOverlayState.visible}
  filterApplyLabel={$t('mapPage.filterStatus.refining') || $t('header.filterStatus.refining')}
  filterApplyProgress={filterApplyOverlayState.progress}
  {styleTransitionOverlaySrc}
  {styleTransitionOverlayVisible}
/>

<style>
  .map-canvas {
    position: fixed;
    inset: 0;
  }
</style>
