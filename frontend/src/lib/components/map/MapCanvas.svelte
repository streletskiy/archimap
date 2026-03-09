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
    bringSearchResultsLayersToFront,
    CARTO_BUILDING_LAYER_IDS,
    ensureRegionBuildingSourceAndLayers,
    ensureSearchResultsSourceAndLayers,
    getCurrentBuildingSourceConfigs,
    getCurrentBuildingsFillLayerIds,
    getCurrentBuildingsLineLayerIds,
    getCurrentFilterHighlightFillLayerIds,
    getCurrentFilterHighlightLineLayerIds,
    getCurrentSelectedFillLayerIds,
    getCurrentSelectedLineLayerIds,
    removeRegionBuildingSourceAndLayers
  } from '$lib/services/map/map-layer-utils';
  import {
    fitMapToSearchResults as fitMapToSearchItems,
    SEARCH_RESULTS_CLUSTER_LAYER_ID,
    SEARCH_RESULTS_LAYER_ID,
    SEARCH_RESULTS_SOURCE_ID,
    updateSearchMarkers as updateSearchMarkerSource
  } from '$lib/services/map/map-search-utils';
  import {
    getBuildingThemePaint,
    getCurrentTheme,
    getMapStyleForTheme,
    LIGHT_MAP_STYLE_URL,
    STYLE_OVERLAY_FADE_MS
  } from '$lib/services/map/map-theme-utils';
  import { loadMapRuntime } from '$lib/services/map-runtime';
  import {
    getActiveRegionPmtiles,
    pointInBounds
  } from '$lib/services/region-pmtiles';
  import { t, translateNow } from '$lib/i18n/index';
  import {
    lastMapCamera,
    mapFocusRequest,
    mapLabelsVisible,
    normalizeOptionalMapZoom,
    resolveInitialMapCamera,
    selectedBuilding,
    setMapCenter,
    setMapReady,
    setMapViewport,
    setMapZoom
  } from '$lib/stores/map';
  import { buildingFilterRules, setBuildingFilterRuntimeStatus } from '$lib/stores/filters';
  import { searchMapState, searchState } from '$lib/stores/search';
  import { encodeOsmFeatureId, getFeatureIdentity, getSelectionFilter } from './selection-utils';
  import { buildBboxSnapshot } from './filter-pipeline-utils';

  const dispatch = createEventDispatcher();
  const CARTO_SHOW_DELAY_MS = 160;

  let container;
  let map = null;
  let maplibregl = null;
  let protocol = null;
  let activeRegionPmtiles = [];
  let themeObserver = null;
  let coverageDebounceTimer = null;
  let cartoShowTimer = null;
  let coverageEvalToken = 0;
  let coverageVisibleState = 'visible';
  let lastSelectedKey = null;
  let lastSearchFitSeq = 0;
  let lastMapFocusRequestId = null;
  let currentMapStyleUrl = LIGHT_MAP_STYLE_URL;
  let runtimeConfig = null;
  let styleTransitionOverlaySrc = null;
  let styleTransitionOverlayVisible = false;
  let styleTransitionTimer = null;
  let lastHandledBuildingClickSig = null;
  let filterStatusOverlayText = '';
  let cameraStoreSyncEnabled = false;

  function getCurrentMapLayerIds() {
    return {
      buildingFillLayerIds: getCurrentBuildingsFillLayerIds(activeRegionPmtiles),
      buildingLineLayerIds: getCurrentBuildingsLineLayerIds(activeRegionPmtiles),
      filterHighlightFillLayerIds: getCurrentFilterHighlightFillLayerIds(activeRegionPmtiles),
      filterHighlightLineLayerIds: getCurrentFilterHighlightLineLayerIds(activeRegionPmtiles),
      selectedFillLayerIds: getCurrentSelectedFillLayerIds(activeRegionPmtiles),
      selectedLineLayerIds: getCurrentSelectedLineLayerIds(activeRegionPmtiles)
    };
  }

  function getAllCurrentMapLayerIds() {
    const layerIds = getCurrentMapLayerIds();
    return [
      ...layerIds.buildingFillLayerIds,
      ...layerIds.buildingLineLayerIds,
      ...layerIds.filterHighlightFillLayerIds,
      ...layerIds.filterHighlightLineLayerIds,
      ...layerIds.selectedFillLayerIds,
      ...layerIds.selectedLineLayerIds
    ];
  }

  const mapDebug = createMapDebugController({
    getMap: () => map,
    getLayerIds: getAllCurrentMapLayerIds,
    isFilterDebugEnabled,
    telemetryEnabled: FILTER_TELEMETRY_ENABLED
  });

  const filterPipeline = createFilterPipeline({
    map: () => map,
    mapDebug,
    getLayerIds: getCurrentMapLayerIds,
    getBuildingSourceConfigs: () => getCurrentBuildingSourceConfigs(activeRegionPmtiles),
    onStatusChange: setBuildingFilterRuntimeStatus,
    translateInvalidMessage: () => translateNow('mapPage.filterStatus.invalid')
  });

  const filterState = filterPipeline.state;

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

  function getConfiguredRegionPmtiles(config = runtimeConfig) {
    return Array.isArray(config?.buildingRegionsPmtiles) ? config.buildingRegionsPmtiles : [];
  }

  function getViewportActiveRegionPmtiles(config = runtimeConfig) {
    if (!map) return [];
    return getActiveRegionPmtiles(getConfiguredRegionPmtiles(config), map.getBounds());
  }

  function getPrimaryBuildingFeature(event) {
    if (!map) return null;
    const searchFeatures = map.queryRenderedFeatures(event.point, {
      layers: [SEARCH_RESULTS_CLUSTER_LAYER_ID, SEARCH_RESULTS_LAYER_ID]
    });
    if (Array.isArray(searchFeatures) && searchFeatures.length > 0) {
      return null;
    }
    const buildingLayerIds = [
      ...getCurrentBuildingsLineLayerIds(activeRegionPmtiles),
      ...getCurrentBuildingsFillLayerIds(activeRegionPmtiles)
    ];
    if (buildingLayerIds.length === 0) return null;
    const features = map.queryRenderedFeatures(event.point, {
      layers: buildingLayerIds
    });
    return features?.[0] || null;
  }

  function handleMapBuildingClick(event) {
    const feature = getPrimaryBuildingFeature(event);
    if (!feature) return;
    const identity = getFeatureIdentity(feature);
    if (!identity) return;
    const clickSig = `${event?.originalEvent?.timeStamp || ''}:${event?.point?.x || ''}:${event?.point?.y || ''}:${identity.osmType}/${identity.osmId}`;
    if (clickSig === lastHandledBuildingClickSig) return;
    lastHandledBuildingClickSig = clickSig;
    selectBuildingOnMap({
      source: 'map-click',
      feature,
      identity,
      lngLat: event?.lngLat
    });
  }

  function focusSelectedFeature({ feature, identity, lngLat }) {
    if (!map) return;
    const filter = getSelectionFilter(feature, identity);
    const selectionKey = `${identity?.osmType || '?'}/${identity?.osmId || '?'}`;
    for (const layerId of getCurrentSelectedFillLayerIds(activeRegionPmtiles)) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
      recordDebugSetFilter(layerId);
    }
    for (const layerId of getCurrentSelectedLineLayerIds(activeRegionPmtiles)) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
      recordDebugSetFilter(layerId);
    }
    debugSelectionLog('highlight-applied', {
      method: 'setFilter',
      selectionKey,
      encodedId: identity?.osmType && Number.isInteger(identity?.osmId)
        ? encodeOsmFeatureId(identity.osmType, identity.osmId)
        : null
    });

    if (!lngLat) return;
    const desktopOffsetX = window.innerWidth >= 1024 ? -Math.round(window.innerWidth * 0.18) : 0;
    debugSelectionLog('zoom-start', {
      selectionKey,
      center: { lon: Number(lngLat.lng), lat: Number(lngLat.lat) }
    });
    map.easeTo({
      center: lngLat,
      offset: [desktopOffsetX, 0],
      duration: 420,
      essential: true
    });
    map.once('moveend', () => {
      debugSelectionLog('zoom-end', {
        selectionKey
      });
    });
  }

  function selectBuildingOnMap({ source, feature, identity, lngLat, lon = null, lat = null }) {
    focusSelectedFeature({ feature, identity, lngLat });
    debugSelectionLog('building-click', {
      source,
      layerId: feature?.layer?.id || null,
      featureId: feature?.id ?? null,
      properties: feature?.properties || null,
      selectionKey: `${identity.osmType}/${identity.osmId}`
    });
    dispatch('buildingClick', {
      ...identity,
      lon: Number.isFinite(Number(lon)) ? Number(lon) : null,
      lat: Number.isFinite(Number(lat)) ? Number(lat) : null,
      feature
    });
  }

  function clearSelectedFeature() {
    if (!map) return;
    for (const layerId of getCurrentSelectedFillLayerIds(activeRegionPmtiles)) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, ['==', ['id'], -1]);
      recordDebugSetFilter(layerId);
    }
    for (const layerId of getCurrentSelectedLineLayerIds(activeRegionPmtiles)) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, ['==', ['id'], -1]);
      recordDebugSetFilter(layerId);
    }
  }

  function applySelectionFromStore(selection) {
    if (!map || !selection?.osmType || !selection?.osmId) return;
    const identity = {
      osmType: selection.osmType,
      osmId: Number(selection.osmId)
    };
    const filter = getSelectionFilter(null, identity);
    for (const layerId of getCurrentSelectedFillLayerIds(activeRegionPmtiles)) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
      recordDebugSetFilter(layerId);
    }
    for (const layerId of getCurrentSelectedLineLayerIds(activeRegionPmtiles)) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
      recordDebugSetFilter(layerId);
    }
  }

  function updateSearchMarkers(items) {
    updateSearchMarkerSource(map, items);
  }

  function fitMapToSearchResults(items) {
    fitMapToSearchItems(map, items);
  }

  function onSearchClusterClick(event) {
    const feature = event?.features?.[0];
    if (!feature) return;
    const clusterId = feature.properties?.cluster_id;
    const coordinates = feature.geometry?.coordinates;
    const source = map.getSource(SEARCH_RESULTS_SOURCE_ID);
    if (!source || clusterId == null || !Array.isArray(coordinates)) return;
    source.getClusterExpansionZoom(clusterId, (error, zoom) => {
      if (error) return;
      map.easeTo({
        center: coordinates,
        zoom: Number.isFinite(zoom) ? zoom : Math.max(map.getZoom() + 1, 14),
        duration: 350,
        essential: true
      });
    });
  }

  function onSearchResultClick(event) {
    const feature = event?.features?.[0];
    if (!feature) return;
    const osmType = String(feature?.properties?.osm_type || '').trim();
    const osmId = Number(feature?.properties?.osm_id);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) return;

    const lng = Number(feature?.geometry?.coordinates?.[0]);
    const lat = Number(feature?.geometry?.coordinates?.[1]);
    const lngLat = (Number.isFinite(lng) && Number.isFinite(lat)) ? { lng, lat } : event?.lngLat;
    selectBuildingOnMap({
      source: 'search-result',
      feature: null,
      identity: { osmType, osmId },
      lngLat,
      lon: lng,
      lat
    });
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
    applyBuildingThemePaintToLayers({
      map,
      theme,
      fillLayerIds: getCurrentBuildingsFillLayerIds(activeRegionPmtiles),
      lineLayerIds: getCurrentBuildingsLineLayerIds(activeRegionPmtiles)
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
    bindMapInteractionHandlers({
      map,
      buildingFillLayerIds: getCurrentBuildingsFillLayerIds(activeRegionPmtiles),
      buildingLineLayerIds: getCurrentBuildingsLineLayerIds(activeRegionPmtiles),
      onBuildingClick: handleMapBuildingClick,
      onSearchClusterClick,
      onSearchResultClick,
      onPointerEnter,
      onPointerLeave
    });
  }

  function applyLabelLayerVisibility(visible) {
    applyMapLabelLayerVisibility(map, visible);
  }

  function setCartoBuildingsVisibility(nextVisibility) {
    if (!map || !map.isStyleLoaded()) return;
    if (coverageVisibleState === nextVisibility) return;
    for (const layerId of CARTO_BUILDING_LAYER_IDS) {
      if (!map.getLayer(layerId)) continue;
      map.setLayoutProperty(layerId, 'visibility', nextVisibility);
    }
    coverageVisibleState = nextVisibility;
  }

  function queueCartoBuildingsVisibility(nextVisibility) {
    if (nextVisibility === 'none') {
      if (cartoShowTimer) {
        clearTimeout(cartoShowTimer);
        cartoShowTimer = null;
      }
      setCartoBuildingsVisibility('none');
      return;
    }
    if (cartoShowTimer) {
      clearTimeout(cartoShowTimer);
    }
    cartoShowTimer = setTimeout(() => {
      cartoShowTimer = null;
      setCartoBuildingsVisibility('visible');
    }, CARTO_SHOW_DELAY_MS);
  }

  function getViewportSamplePoints() {
    if (!map) return [];
    const bounds = map.getBounds();
    if (!bounds) return [];
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const center = map.getCenter();
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

  async function evaluatePmtilesCoverage() {
    if (!map || !map.isStyleLoaded()) return;
    const token = ++coverageEvalToken;
    const regions = activeRegionPmtiles.length > 0
      ? activeRegionPmtiles
      : getViewportActiveRegionPmtiles(runtimeConfig);
    if (regions.length === 0) {
      queueCartoBuildingsVisibility('visible');
      return;
    }
    const points = getViewportSamplePoints();
    if (points.length === 0) return;
    for (const [lon, lat] of points) {
      if (token !== coverageEvalToken) return;
      const covered = regions.some((region) => pointInBounds(lon, lat, region.bounds));
      if (!covered) {
        queueCartoBuildingsVisibility('visible');
        return;
      }
    }
    queueCartoBuildingsVisibility('none');
  }

  function scheduleCoverageCheck() {
    if (coverageDebounceTimer) {
      clearTimeout(coverageDebounceTimer);
      coverageDebounceTimer = null;
    }
    coverageDebounceTimer = setTimeout(() => {
      coverageDebounceTimer = null;
      evaluatePmtilesCoverage();
    }, 80);
  }

  function ensureMapSourcesAndLayers(config) {
    if (!map) return;
    const theme = getCurrentTheme();
    const buildingPaint = getBuildingThemePaint(theme);
    ensureSearchResultsSourceAndLayers(map, $searchMapState.items);

    const nextActiveRegions = getViewportActiveRegionPmtiles(config);
    const nextIds = new Set(nextActiveRegions.map((region) => region.id));
    for (const currentRegion of activeRegionPmtiles) {
      if (nextIds.has(currentRegion.id)) continue;
      removeRegionBuildingSourceAndLayers(map, currentRegion.id);
    }
    activeRegionPmtiles = nextActiveRegions;
    for (const region of nextActiveRegions) {
      ensureRegionBuildingSourceAndLayers({
        map,
        region,
        buildingPaint,
        origin: window.location.origin
      });
    }
    bringSearchResultsLayersToFront(map);

    bindStyleInteractionHandlers();
    applySelectionFromStore($selectedBuilding);
    updateSearchMarkers($searchMapState.items);
    applyBuildingThemePaint(theme);
    applyLabelLayerVisibility($mapLabelsVisible);
    scheduleCoverageCheck();
    filterPipeline.refreshDebugState(Array.isArray($buildingFilterRules) && $buildingFilterRules.length > 0);
    filterPipeline.reapplyFilteredFeatureState();
  }

  function syncMapRegionSources() {
    if (!map || !runtimeConfig) return;
    ensureMapSourcesAndLayers(runtimeConfig);
  }

  function restoreCustomLayersAfterStyleChange() {
    if (!map || !runtimeConfig) return;
    const tryRestore = () => {
      if (!map || !runtimeConfig) return;
      if (!map.isStyleLoaded()) return;
      ensureMapSourcesAndLayers(runtimeConfig);
      applyBuildingThemePaint(getCurrentTheme());
      filterPipeline.applyBuildingFilters($buildingFilterRules, { reason: 'style' });
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
    clearSelectedFeature();
  }

  $: if (map && $selectedBuilding?.osmType && $selectedBuilding?.osmId) {
    const key = `${$selectedBuilding.osmType}/${$selectedBuilding.osmId}`;
    if (key !== lastSelectedKey) {
      lastSelectedKey = key;
      applySelectionFromStore($selectedBuilding);
    }
  }

  $: if (map) {
    const rules = $buildingFilterRules;
    filterPipeline.scheduleFilterRulesRefresh(rules);
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
      coverageVisibleState = 'visible';
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
        syncMapRegionSources();
      });
      map.on('moveend', () => filterPipeline.scheduleFilterRefresh($buildingFilterRules));
      map.on('moveend', scheduleCoverageCheck);
      map.on('move', scheduleCoverageCheck);
      map.on('zoomend', () => filterPipeline.scheduleFilterRefresh($buildingFilterRules));
      map.on('zoomend', syncMapZoomStore);
      map.on('zoomend', syncMapRegionSources);
      map.on('zoomend', scheduleCoverageCheck);
      map.on('resize', syncMapRegionSources);
      map.on('resize', scheduleCoverageCheck);

      map.on('style.load', () => {
        ensureMapSourcesAndLayers(config);
        filterPipeline.scheduleFilterRefresh($buildingFilterRules);
        scheduleCoverageCheck();
      });

      map.on('load', () => {
        cameraStoreSyncEnabled = true;
        filterPipeline.registerFilterMoveEnd();
        syncMapCameraStores();
        setMapReady(true);
        scheduleCoverageCheck();
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
    if (coverageDebounceTimer) {
      clearTimeout(coverageDebounceTimer);
      coverageDebounceTimer = null;
    }
    if (cartoShowTimer) {
      clearTimeout(cartoShowTimer);
      cartoShowTimer = null;
    }
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
  data-filter-set-feature-state-calls={String($filterState.setFeatureStateCallsLast)}
  data-filter-last-apply-diff-ms={String($filterState.lastApplyDiffMs)}
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
