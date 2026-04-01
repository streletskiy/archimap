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
    shouldShowFilterRefiningMessage
  } from '$lib/services/map/filter-overlay-utils';
  import {
    bringBaseLabelLayersAboveCustomLayers,
    bringSearchResultsLayersToFront,
    applyBuildingThemePaint as applyBuildingThemePaintToLayers,
    applyBuildingPartsLayerVisibility as applyBuildingPartsLayerVisibilityToLayers,
    applyLabelLayerVisibility as applyMapLabelLayerVisibility,
    bindMapInteractionHandlers,
    ensureOverpassBuildingSourceAndLayers,
    getCurrentOverpassBuildingsExtrusionLayerIds,
    getCurrentOverpassBuildingsFillLayerIds,
    getCurrentOverpassBuildingsLineLayerIds,
    getCurrentOverpassBuildingPartExtrusionLayerIds,
    getCurrentOverpassBuildingPartFillLayerIds,
    getCurrentOverpassBuildingPartLineLayerIds,
    getCurrentOverpassBuildingPartFilterHighlightExtrusionLayerIds,
    getCurrentOverpassBuildingPartFilterHighlightFillLayerIds,
    getCurrentOverpassBuildingPartFilterHighlightLineLayerIds,
    getCurrentOverpassBuildingHoverExtrusionLayerIds,
    getCurrentOverpassBuildingHoverFillLayerIds,
    getCurrentOverpassBuildingHoverLineLayerIds,
    getCurrentBuildingsExtrusionLayerIds,
    getCurrentBuildingsFillLayerIds,
    getCurrentBuildingsLineLayerIds,
    getCurrentBuildingPartExtrusionLayerIds,
    getCurrentBuildingPartFillLayerIds,
    getCurrentBuildingPartLineLayerIds,
    getCurrentBuildingPartFilterHighlightExtrusionLayerIds,
    getCurrentBuildingHoverExtrusionLayerIds,
    getCurrentBuildingHoverFillLayerIds,
    getCurrentBuildingHoverLineLayerIds,
    getCurrentFilterHighlightExtrusionLayerIds,
    getCurrentFilterHighlightFillLayerIds,
    getCurrentFilterHighlightLineLayerIds,
    getCurrentOverpassFilterHighlightExtrusionLayerIds,
    getCurrentOverpassFilterHighlightFillLayerIds,
    getCurrentOverpassFilterHighlightLineLayerIds,
    getCurrentOverpassSelectedExtrusionLayerIds,
    getCurrentOverpassSelectedFillLayerIds,
    getCurrentOverpassSelectedLineLayerIds,
    getCurrentSelectedExtrusionLayerIds,
    getCurrentSelectedFillLayerIds,
    getCurrentSelectedLineLayerIds,
    getRegionLayerIds
  } from '$lib/services/map/map-layer-utils';
  import {
    fitMapToSearchResults as fitMapToSearchItems,
    updateSearchMarkers as updateSearchMarkerSource
  } from '$lib/services/map/map-search-utils';
  import {
    getBuildingHoverThemePaint,
    getBuildingThemePaint,
    getCurrentTheme,
    getMapStyleSignature,
    resolveMapStyleForTheme,
    STYLE_OVERLAY_FADE_MS
  } from '$lib/services/map/map-theme-utils';
  import {
    DEFAULT_MAP_3D_PITCH,
    getEffectiveBuildingPartsVisibility
  } from '$lib/services/map/map-3d-utils';
  import {
    shouldCheckOverpassViewportCoverage,
    cancelOverpassViewportLoad,
    clearOverpassCache,
    getOverpassFeatureCollection,
    getOverpassStateSnapshot,
    overpassBuildingsState,
    requestOverpassViewportLoad,
    refreshOverpassViewportData,
    scheduleOverpassViewportRefresh
  } from '$lib/services/map/overpass-buildings';
  import { loadMapRuntime } from '$lib/services/map-runtime';
  import { locale, t, translateNow } from '$lib/i18n/index';
  import {
    lastMapCamera,
    mapFocusRequest,
    mapLabelsVisible,
    mapBuildings3dEnabled,
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
  import { pointInBounds } from '$lib/services/region-pmtiles';
  import { createMapRegionLayersController } from './map-region-layers-controller';
  import { createMapSelectionController } from './map-selection-controller';
  import { buildBboxSnapshot } from './filter-pipeline-utils';
  import OverpassFallbackOverlay from './OverpassFallbackOverlay.svelte';

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
  let currentMapStyleSignature = '';
  let runtimeConfig = null;
  let styleTransitionOverlaySrc = null;
  let styleTransitionOverlayVisible = false;
  let styleTransitionTimer = null;
  let mapStyleRequestSeq = 0;
  let stopBuildingFilterLayers = null;
  let currentBuildingFilterLayers = [];
  let filterStatusOverlayText;
  let filterApplyClock = Date.now();
  let filterApplyClockTimer = null;
  let currentMapZoom = Number.NaN;
  let overpassLayerVisible = false;
  let overpassViewportCovered = true;
  let overpassViewportPrimeTimer = null;
  let overpassFallbackVisible;
  let overpassHasCachedData = false;
  let lastOverpassDataVersion;
  let lastOverpassLoading;
  let cameraStoreSyncEnabled = false;
  let effectiveBuildingPartsVisible = false;

  $: effectiveBuildingPartsVisible = getEffectiveBuildingPartsVisibility({
    buildingPartsVisible: $mapBuildingPartsVisible,
    buildings3dEnabled: $mapBuildings3dEnabled
  });

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
  $: {
    const nextFilterApplyOverlayState = getFilterApplyOverlayState($filterState, $buildingFilterRuntime, filterApplyClock, currentMapZoom);
    const nextFilterApplyVisible = Boolean(nextFilterApplyOverlayState.visible);
    if (typeof window !== 'undefined') {
      if (nextFilterApplyVisible && !filterApplyClockTimer) {
        filterApplyClockTimer = window.setInterval(() => {
          filterApplyClock = Date.now();
        }, FILTER_APPLY_PROGRESS_TICK_MS);
      } else if (!nextFilterApplyVisible && filterApplyClockTimer) {
        clearInterval(filterApplyClockTimer);
        filterApplyClockTimer = null;
      }
    }
  }
  $: if (map) {
    const nextOverpassDataVersion = Number($overpassBuildingsState.dataVersion || 0);
    const nextOverpassLoading = Boolean($overpassBuildingsState.loading);
    overpassHasCachedData = Boolean(
      Number($overpassBuildingsState.lastSyncedAt || 0) > 0
        || Number($overpassBuildingsState.featureCount || 0) > 0
        || Number($overpassBuildingsState.tileCount || 0) > 0
    );
    $mapBuildings3dEnabled;
    $mapBuildingPartsVisible;
    currentBuildingFilterLayers;
    overpassLayerVisible;
    syncOverpassMapLayers();
    recordOverpassDebugState();
    if (
      currentBuildingFilterLayers.length > 0
      && (
        (Number.isFinite(lastOverpassDataVersion) && nextOverpassDataVersion !== lastOverpassDataVersion && !nextOverpassLoading)
        || (lastOverpassLoading && !nextOverpassLoading)
      )
    ) {
      filterPipeline.scheduleFilterRefresh(currentBuildingFilterLayers, { reason: 'data' });
    }
    lastOverpassDataVersion = nextOverpassDataVersion;
    lastOverpassLoading = nextOverpassLoading;
    void lastOverpassDataVersion;
    void lastOverpassLoading;
  }

  $: overpassFallbackVisible = Boolean(
    !overpassViewportCovered
      && (
        $overpassBuildingsState.promptVisible
        || $overpassBuildingsState.loading
        || Boolean($overpassBuildingsState.error)
        || overpassHasCachedData
      )
  );

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

  function recordOverpassDebugState(extra = {}) {
    if (typeof window === 'undefined') return;
    window.__MAP_DEBUG__ = window.__MAP_DEBUG__ || {};
    window.__MAP_DEBUG__.overpass = {
      ...getOverpassStateSnapshot(),
      covered: overpassViewportCovered,
      layerVisible: overpassLayerVisible,
      zoom: currentMapZoom,
      ...extra
    };
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
    getBuildings3dEnabled: () => $mapBuildings3dEnabled,
    getBuildingPartsVisible: () => effectiveBuildingPartsVisible,
    getBuildingFilterLayers: () => currentBuildingFilterLayers,
    getWindowOrigin: () => window.location.origin,
    onBindStyleInteractionHandlers: () => bindStyleInteractionHandlers(),
    onApplySelectionFromStore: (selection) => selectionController.applySelectionFromStore(selection),
    onUpdateSearchMarkers: (items) => updateSearchMarkers(items),
    onApplyBuildingThemePaint: (theme) => applyBuildingThemePaint(theme),
    onApplyLabelLayerVisibility: (visible) => applyLabelLayerVisibility(visible),
    onApplyBuildingPartsLayerVisibility: () => applyBuildingPartsLayerVisibility(effectiveBuildingPartsVisible, {
      buildings3dEnabled: $mapBuildings3dEnabled,
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
    getSourceDataVersion: () => $overpassBuildingsState.dataVersion,
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
    getBuildings3dEnabled: () => $mapBuildings3dEnabled,
    getBuildingPartsVisible: () => effectiveBuildingPartsVisible,
    recordDebugSetFilter,
    debugSelectionLog,
    dispatchBuildingClick: (payload) => dispatch('buildingClick', payload)
  });

  const handleBuildingClick = (event) => selectionController.handleMapBuildingClick(event);
  const handleSearchClusterClick = (event) => selectionController.onSearchClusterClick(event);
  const handleSearchResultClick = (event) => selectionController.onSearchResultClick(event);
  const handleMapPointerMove = (event) => selectionController.handleMapPointerMove(event);
  const handleMapPointerLeave = () => selectionController.handleMapPointerLeave();

  function getViewportSamplePoints(bounds = map?.getBounds?.(), mapRef = map) {
    if (!bounds || !mapRef) return [];
    const west = Number(bounds.getWest?.());
    const east = Number(bounds.getEast?.());
    const south = Number(bounds.getSouth?.());
    const north = Number(bounds.getNorth?.());
    if (![west, east, south, north].every(Number.isFinite)) return [];
    const center = mapRef.getCenter?.();
    if (!center) return [];
    const midLon = (west + east) / 2;
    const midLat = (north + south) / 2;
    return [
      [center.lng, center.lat],
      [west, north],
      [east, north],
      [east, south],
      [west, south],
      [midLon, north],
      [midLon, south],
      [west, midLat],
      [east, midLat]
    ];
  }

  function getCoverageRegions() {
    const activeRegions = regionLayersController.getActiveRegionPmtiles();
    if (Array.isArray(activeRegions) && activeRegions.length > 0) {
      return activeRegions;
    }
    return Array.isArray(runtimeConfig?.buildingRegionsPmtiles)
      ? runtimeConfig.buildingRegionsPmtiles
      : [];
  }

  function isViewportCoveredByProcessedRegions() {
    if (!shouldCheckOverpassViewportCoverage(currentMapZoom)) {
      return true;
    }
    const regions = getCoverageRegions();
    const points = getViewportSamplePoints();
    if (regions.length === 0 || points.length === 0) return false;
    return points.every(([lon, lat]) => regions.some((region) => pointInBounds(lon, lat, region.bounds)));
  }

  function syncOverpassMapLayers() {
    if (!map || !runtimeConfig || !map.isStyleLoaded?.()) return;
    const theme = getCurrentTheme();
    const buildingPaint = getBuildingThemePaint(theme);
    const hoverPaint = getBuildingHoverThemePaint(theme);
    ensureOverpassBuildingSourceAndLayers({
      map,
      data: getOverpassFeatureCollection(),
      buildingPaint,
      hoverPaint,
      buildings3dEnabled: $mapBuildings3dEnabled,
      buildingPartsVisible: effectiveBuildingPartsVisible,
      buildingPartHighlightVisible: currentBuildingFilterLayers.length > 0,
      visible: overpassLayerVisible
    });
    bringSearchResultsLayersToFront(map);
    bringBaseLabelLayersAboveCustomLayers(map);
  }

  function getOverpassViewportPayload() {
    if (!map || !runtimeConfig) return null;
    overpassViewportCovered = isViewportCoveredByProcessedRegions();
    overpassLayerVisible = Boolean(!overpassViewportCovered && Number.isFinite(currentMapZoom) && currentMapZoom >= 13);
    const viewport = buildBboxSnapshot(map.getBounds?.());
    if (!viewport || !Number.isFinite(currentMapZoom)) {
      return null;
    }
    const payload = {
      viewport,
      zoom: currentMapZoom,
      covered: overpassViewportCovered
    };
    recordOverpassDebugState({
      viewportPresent: Boolean(viewport),
      viewportHash: viewport ? `${viewport.west}:${viewport.south}:${viewport.east}:${viewport.north}` : ''
    });
    return payload;
  }

  function scheduleOverpassViewportPrime({ load = false } = {}) {
    if (typeof window === 'undefined') return;
    if (overpassViewportPrimeTimer) {
      clearTimeout(overpassViewportPrimeTimer);
    }
    overpassViewportPrimeTimer = window.setTimeout(() => {
      overpassViewportPrimeTimer = null;
      syncOverpassViewportState({ load });
    }, 120);
  }

  function syncOverpassViewportState({ load = false } = {}) {
    const payload = getOverpassViewportPayload();
    if (!payload) {
      scheduleOverpassViewportPrime({ load });
      return;
    }
    if (load) {
      void requestOverpassViewportLoad(payload);
    } else {
      void scheduleOverpassViewportRefresh(payload);
    }
    syncOverpassMapLayers();
  }

  function handleOverpassFallbackLoad() {
    const payload = getOverpassViewportPayload();
    if (!payload) return;
    void requestOverpassViewportLoad(payload);
  }

  function handleOverpassFallbackRefresh() {
    const payload = getOverpassViewportPayload();
    if (!payload) return;
    void refreshOverpassViewportData(payload);
  }

  function handleOverpassFallbackClear() {
    void clearOverpassCache();
  }

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
      extrusionLayerIds: getCurrentBuildingsExtrusionLayerIds(activeRegions),
      fillLayerIds: getCurrentBuildingsFillLayerIds(activeRegions),
      lineLayerIds: getCurrentBuildingsLineLayerIds(activeRegions),
      partExtrusionLayerIds: getCurrentBuildingPartExtrusionLayerIds(activeRegions),
      partFillLayerIds: getCurrentBuildingPartFillLayerIds(activeRegions),
      partLineLayerIds: getCurrentBuildingPartLineLayerIds(activeRegions),
      hoverExtrusionLayerIds: getCurrentBuildingHoverExtrusionLayerIds(activeRegions),
      hoverFillLayerIds: getCurrentBuildingHoverFillLayerIds(activeRegions),
      hoverLineLayerIds: getCurrentBuildingHoverLineLayerIds(activeRegions)
    });
  }

  function applyBuildingPartsLayerVisibility(
    visible = effectiveBuildingPartsVisible,
    {
      buildings3dEnabled = $mapBuildings3dEnabled,
      forceHighlightVisible = false
    } = {}
  ) {
    const activeRegions = regionLayersController.getActiveRegionPmtiles();
    applyBuildingPartsLayerVisibilityToLayers({
      map,
      sourceVisible: true,
      partVisible: visible,
      buildings3dEnabled,
      fillLayerIds: getRegionLayerIds(activeRegions, 'fill'),
      extrusionLayerIds: getRegionLayerIds(activeRegions, 'extrusion'),
      lineLayerIds: getRegionLayerIds(activeRegions, 'line'),
      filterHighlightExtrusionLayerIds: getCurrentFilterHighlightExtrusionLayerIds(activeRegions),
      filterHighlightFillLayerIds: getCurrentFilterHighlightFillLayerIds(activeRegions),
      filterHighlightLineLayerIds: getCurrentFilterHighlightLineLayerIds(activeRegions),
      forceHighlightVisible,
      partFillLayerIds: getRegionLayerIds(activeRegions, 'part-fill'),
      partExtrusionLayerIds: getRegionLayerIds(activeRegions, 'part-extrusion'),
      partLineLayerIds: getRegionLayerIds(activeRegions, 'part-line'),
      partFilterHighlightExtrusionLayerIds: getCurrentBuildingPartFilterHighlightExtrusionLayerIds(activeRegions),
      partFilterHighlightFillLayerIds: getRegionLayerIds(activeRegions, 'part-filter-highlight-fill'),
      partFilterHighlightLineLayerIds: getRegionLayerIds(activeRegions, 'part-filter-highlight-line'),
      hoverExtrusionLayerIds: getCurrentBuildingHoverExtrusionLayerIds(activeRegions),
      hoverFillLayerIds: getCurrentBuildingHoverFillLayerIds(activeRegions),
      hoverLineLayerIds: getCurrentBuildingHoverLineLayerIds(activeRegions),
      selectedExtrusionLayerIds: getCurrentSelectedExtrusionLayerIds(activeRegions),
      selectedFillLayerIds: getCurrentSelectedFillLayerIds(activeRegions),
      selectedLineLayerIds: getCurrentSelectedLineLayerIds(activeRegions)
    });
    applyBuildingPartsLayerVisibilityToLayers({
      map,
      sourceVisible: overpassLayerVisible,
      partVisible: visible,
      buildings3dEnabled,
      fillLayerIds: getCurrentOverpassBuildingsFillLayerIds(),
      extrusionLayerIds: getCurrentOverpassBuildingsExtrusionLayerIds(),
      lineLayerIds: getCurrentOverpassBuildingsLineLayerIds(),
      filterHighlightExtrusionLayerIds: getCurrentOverpassFilterHighlightExtrusionLayerIds(),
      filterHighlightFillLayerIds: getCurrentOverpassFilterHighlightFillLayerIds(),
      filterHighlightLineLayerIds: getCurrentOverpassFilterHighlightLineLayerIds(),
      forceHighlightVisible,
      partFillLayerIds: getCurrentOverpassBuildingPartFillLayerIds(),
      partExtrusionLayerIds: getCurrentOverpassBuildingPartExtrusionLayerIds(),
      partLineLayerIds: getCurrentOverpassBuildingPartLineLayerIds(),
      partFilterHighlightExtrusionLayerIds: getCurrentOverpassBuildingPartFilterHighlightExtrusionLayerIds(),
      partFilterHighlightFillLayerIds: getCurrentOverpassBuildingPartFilterHighlightFillLayerIds(),
      partFilterHighlightLineLayerIds: getCurrentOverpassBuildingPartFilterHighlightLineLayerIds(),
      hoverExtrusionLayerIds: getCurrentOverpassBuildingHoverExtrusionLayerIds(),
      hoverFillLayerIds: getCurrentOverpassBuildingHoverFillLayerIds(),
      hoverLineLayerIds: getCurrentOverpassBuildingHoverLineLayerIds(),
      selectedExtrusionLayerIds: getCurrentOverpassSelectedExtrusionLayerIds(),
      selectedFillLayerIds: getCurrentOverpassSelectedFillLayerIds(),
      selectedLineLayerIds: getCurrentOverpassSelectedLineLayerIds()
    });
  }

  function applyBuildings3dCamera(enabled = $mapBuildings3dEnabled, { animate = false } = {}) {
    if (!map) return;
    const targetPitch = enabled ? DEFAULT_MAP_3D_PITCH : 0;
    const currentPitch = Number(map.getPitch?.() ?? 0);
    if (!Number.isFinite(currentPitch) || Math.abs(currentPitch - targetPitch) < 0.1) return;
    map.easeTo({
      pitch: targetPitch,
      duration: animate ? 420 : 0,
      essential: true
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

  async function applyThemeToMap(theme) {
    if (!map || !runtimeConfig) return;
    const nextStyleSignature = getMapStyleSignature(theme, runtimeConfig, get(locale));
    if (nextStyleSignature === currentMapStyleSignature) return;

    const requestSeq = ++mapStyleRequestSeq;
    captureStyleTransitionOverlay();

    try {
      const nextStyle = await resolveMapStyleForTheme(theme, {
        runtimeConfig,
        localeCode: get(locale)
      });
      if (!map || requestSeq !== mapStyleRequestSeq) return;
      currentMapStyleSignature = nextStyleSignature;
      map.setStyle(nextStyle);
      restoreCustomLayersAfterStyleChange();
    } catch {
      if (requestSeq === mapStyleRequestSeq) {
        clearStyleTransitionOverlaySoon();
      }
    }
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
    applyBuildings3dCamera(Boolean($mapBuildings3dEnabled), { animate: true });
  }

  $: if (map) {
    const buildingPartsVisible = effectiveBuildingPartsVisible;
    const buildings3dEnabled = $mapBuildings3dEnabled;
    const forceHighlightVisible = Array.isArray($buildingFilterLayers) && $buildingFilterLayers.length > 0;
    applyBuildingPartsLayerVisibility(buildingPartsVisible, {
      buildings3dEnabled,
      forceHighlightVisible
    });
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
      const currentTheme = getCurrentTheme();
      currentMapStyleSignature = getMapStyleSignature(currentTheme, config, get(locale));
      const initialStyle = await resolveMapStyleForTheme(currentTheme, {
        runtimeConfig: config,
        localeCode: get(locale)
      });
      if (!mountAlive) return;
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
        style: initialStyle,
        center: [initialCamera.lng, initialCamera.lat],
        zoom: Number(initialCamera.z),
        pitch: $mapBuildings3dEnabled ? DEFAULT_MAP_3D_PITCH : 0,
        antialias: true,
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
        syncOverpassViewportState();
      });
      map.on('moveend', () => filterPipeline.scheduleFilterRefresh(currentBuildingFilterLayers));
      map.on('moveend', () => regionLayersController.scheduleCoverageCheck());
      map.on('move', () => regionLayersController.scheduleCoverageCheck());
      map.on('zoomend', () => filterPipeline.scheduleFilterRefresh(currentBuildingFilterLayers));
      map.on('zoomend', syncMapZoomStore);
      map.on('zoomend', () => regionLayersController.syncMapRegionSources());
      map.on('zoomend', () => regionLayersController.scheduleCoverageCheck());
      map.on('zoomend', () => syncOverpassViewportState());
      map.on('resize', () => regionLayersController.syncMapRegionSources());
      map.on('resize', () => regionLayersController.scheduleCoverageCheck());
      map.on('resize', () => syncOverpassViewportState());
      map.on('mousemove', handleMapPointerMove);
      map.on('mouseleave', handleMapPointerLeave);
      map.on('mouseout', handleMapPointerLeave);

      // Prime the viewport-dependent state immediately so fallback UI does not
      // wait for the first camera event to appear.
      syncOverpassViewportState();

      map.on('style.load', () => {
        regionLayersController.ensureMapSourcesAndLayers(config, { force: true });
        filterPipeline.scheduleFilterRefresh(currentBuildingFilterLayers);
        regionLayersController.scheduleCoverageCheck();
        syncOverpassViewportState();
      });

      map.on('load', () => {
        cameraStoreSyncEnabled = true;
        filterPipeline.registerFilterMoveEnd();
        syncMapCameraStores();
        regionLayersController.syncMapRegionSources();
        setMapReady(true);
        filterPipeline.scheduleFilterRulesRefresh(currentBuildingFilterLayers);
        regionLayersController.scheduleCoverageCheck();
        syncOverpassViewportState();
      });

      themeObserver = new MutationObserver(() => {
        void applyThemeToMap(getCurrentTheme());
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme']
      });
      const unsubscribeLocale = locale.subscribe(() => {
        void applyThemeToMap(getCurrentTheme());
      });

      return () => {
        unsubscribeLocale();
      };
    }

    let cleanupLocaleSubscription = null;

    initMap()
      .then((cleanup) => {
        cleanupLocaleSubscription = typeof cleanup === 'function' ? cleanup : null;
      })
      .catch(() => {
        cleanupLocaleSubscription = null;
      });

    return () => {
      if (cleanupLocaleSubscription) {
        cleanupLocaleSubscription();
        cleanupLocaleSubscription = null;
      }
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
    cancelOverpassViewportLoad();
    if (styleTransitionTimer) {
      clearTimeout(styleTransitionTimer);
      styleTransitionTimer = null;
    }
    if (overpassViewportPrimeTimer) {
      clearTimeout(overpassViewportPrimeTimer);
      overpassViewportPrimeTimer = null;
    }
    recordOverpassDebugState();
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
  filterApplyVisible={getFilterApplyOverlayState($filterState, $buildingFilterRuntime, filterApplyClock, currentMapZoom).visible}
  filterApplyLabel={$t('mapPage.filterStatus.refining') || $t('header.filterStatus.refining')}
  filterApplyProgress={getFilterApplyOverlayState($filterState, $buildingFilterRuntime, filterApplyClock, currentMapZoom).progress}
  {styleTransitionOverlaySrc}
  {styleTransitionOverlayVisible}
/>
<OverpassFallbackOverlay
  visible={overpassFallbackVisible}
  loading={$overpassBuildingsState.loading}
  canLoad={$overpassBuildingsState.canLoad}
  hasCachedData={overpassHasCachedData}
  messageKey={$overpassBuildingsState.messageKey}
  message={$overpassBuildingsState.message}
  error={$overpassBuildingsState.error}
  progressDone={$overpassBuildingsState.progressDone}
  progressTotal={$overpassBuildingsState.progressTotal}
  lastSyncedAt={$overpassBuildingsState.lastSyncedAt}
  onLoad={handleOverpassFallbackLoad}
  onRefresh={handleOverpassFallbackRefresh}
  onClearCache={handleOverpassFallbackClear}
/>

<style>
  .map-canvas {
    position: fixed;
    inset: 0;
  }
</style>
