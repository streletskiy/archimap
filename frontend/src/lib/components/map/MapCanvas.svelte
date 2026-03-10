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
    applyBuildingThemePaint as applyBuildingThemePaintToLayers,
    applyLabelLayerVisibility as applyMapLabelLayerVisibility,
    bindMapInteractionHandlers,
    getCurrentBuildingsFillLayerIds,
    getCurrentBuildingsLineLayerIds
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
    mapReady as mapReadyStore,
    normalizeOptionalMapZoom,
    resolveInitialMapCamera,
    selectedBuilding,
    setMapCenter,
    setMapReady,
    setMapViewport,
    setMapZoom
  } from '$lib/stores/map';
  import { buildingFilterLayers, setBuildingFilterRuntimeStatus } from '$lib/stores/filters';
  import { searchMapState, searchState } from '$lib/stores/search';
  import { createMapRegionLayersController } from './map-region-layers-controller';
  import { createMapSelectionController } from './map-selection-controller';
  import { buildBboxSnapshot } from './filter-pipeline-utils';

  const dispatch = createEventDispatcher();

  let container;
  let map = null;
  let maplibregl = null;
  let protocol = null;
  let themeObserver = null;
  let lastSelectedKey = null;
  let lastSearchFitSeq = 0;
  let lastMapFocusRequestId = null;
  let currentMapStyleUrl = LIGHT_MAP_STYLE_URL;
  let runtimeConfig = null;
  let styleTransitionOverlaySrc = null;
  let styleTransitionOverlayVisible = false;
  let styleTransitionTimer = null;
  let filterStatusOverlayText = '';
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

  function getFilterStatusOverlayText(statusCode) {
    const code = String(statusCode || 'idle');
    if (code === 'refining') return $t('mapPage.filterStatus.refining') || $t('header.filterStatus.refining');
    if (code === 'too_many_matches') return $t('mapPage.filterStatus.tooMany') || $t('header.filterStatus.tooMany');
    if (code === 'truncated') return $t('mapPage.filterStatus.truncated') || $t('header.filterStatus.truncated');
    if (code === 'invalid') return $t('mapPage.filterStatus.invalid') || $t('header.filterStatus.invalid');
    return '';
  }

  $: filterStatusOverlayText = getFilterStatusOverlayText($filterState.statusCode);

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

  const regionLayersController = createMapRegionLayersController({
    getMap: () => map,
    getRuntimeConfig: () => runtimeConfig,
    getCurrentTheme,
    getSearchItems: () => $searchMapState.items,
    getSelectedBuilding: () => $selectedBuilding,
    getMapLabelsVisible: () => $mapLabelsVisible,
    getBuildingFilterLayers: () => $buildingFilterLayers,
    getWindowOrigin: () => window.location.origin,
    onBindStyleInteractionHandlers: () => bindStyleInteractionHandlers(),
    onApplySelectionFromStore: (selection) => selectionController.applySelectionFromStore(selection),
    onUpdateSearchMarkers: (items) => updateSearchMarkers(items),
    onApplyBuildingThemePaint: (theme) => applyBuildingThemePaint(theme),
    onApplyLabelLayerVisibility: (visible) => applyLabelLayerVisibility(visible),
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

  const selectionController = createMapSelectionController({
    getMap: () => map,
    getActiveRegions: () => regionLayersController.getActiveRegionPmtiles(),
    recordDebugSetFilter,
    debugSelectionLog,
    dispatchBuildingClick: (payload) => dispatch('buildingClick', payload)
  });

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
      lineLayerIds: getCurrentBuildingsLineLayerIds(activeRegions)
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

  function onPointerEnter() {
    if (!map) return;
    map.getCanvas().style.cursor = 'pointer';
  }

  function onPointerLeave() {
    if (!map) return;
    map.getCanvas().style.cursor = '';
  }

  function bindStyleInteractionHandlers() {
    const layerIds = regionLayersController.getCurrentMapLayerIds();
    bindMapInteractionHandlers({
      map,
      buildingFillLayerIds: layerIds.buildingFillLayerIds,
      buildingLineLayerIds: layerIds.buildingLineLayerIds,
      onBuildingClick: (event) => selectionController.handleMapBuildingClick(event),
      onSearchClusterClick: (event) => selectionController.onSearchClusterClick(event),
      onSearchResultClick: (event) => selectionController.onSearchResultClick(event),
      onPointerEnter,
      onPointerLeave
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
      filterPipeline.applyBuildingFilters($buildingFilterLayers, { reason: 'style' });
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

  $: if (map && !$selectedBuilding) {
    lastSelectedKey = null;
    selectionController.clearSelectedFeature();
  }

  $: if (map && $selectedBuilding?.osmType && $selectedBuilding?.osmId) {
    const key = `${$selectedBuilding.osmType}/${$selectedBuilding.osmId}`;
    if (key !== lastSelectedKey) {
      lastSelectedKey = key;
      selectionController.applySelectionFromStore($selectedBuilding);
    }
  }

  $: if (map && $mapReadyStore) {
    const layers = $buildingFilterLayers;
    filterPipeline.scheduleFilterRulesRefresh(layers);
  }

  $: if (map) {
    updateSearchMarkers($searchMapState.items);
  }

  $: if (map && $searchState.fitSeq !== lastSearchFitSeq) {
    lastSearchFitSeq = $searchState.fitSeq;
    fitMapToSearchResults($searchState.items);
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
  }

  $: if (map) {
    applyLabelLayerVisibility($mapLabelsVisible);
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
      map.on('moveend', () => filterPipeline.scheduleFilterRefresh($buildingFilterLayers));
      map.on('moveend', () => regionLayersController.scheduleCoverageCheck());
      map.on('move', () => regionLayersController.scheduleCoverageCheck());
      map.on('zoomend', () => filterPipeline.scheduleFilterRefresh($buildingFilterLayers));
      map.on('zoomend', syncMapZoomStore);
      map.on('zoomend', () => regionLayersController.syncMapRegionSources());
      map.on('zoomend', () => regionLayersController.scheduleCoverageCheck());
      map.on('resize', () => regionLayersController.syncMapRegionSources());
      map.on('resize', () => regionLayersController.scheduleCoverageCheck());

      map.on('style.load', () => {
        regionLayersController.ensureMapSourcesAndLayers(config, { force: true });
        if ($mapReadyStore) {
          filterPipeline.scheduleFilterRefresh($buildingFilterLayers);
        }
        regionLayersController.scheduleCoverageCheck();
      });

      map.on('load', () => {
        cameraStoreSyncEnabled = true;
        filterPipeline.registerFilterMoveEnd();
        syncMapCameraStores();
        setMapReady(true);
        filterPipeline.scheduleFilterRulesRefresh($buildingFilterLayers);
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
  {styleTransitionOverlaySrc}
  {styleTransitionOverlayVisible}
/>

<style>
  .map-canvas {
    position: fixed;
    inset: 0;
  }
</style>
