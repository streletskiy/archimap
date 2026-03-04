<script>
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { getRuntimeConfig } from '$lib/services/config';
  import { apiJson } from '$lib/services/http';
  import { mapFocusRequest, mapLabelsVisible, selectedBuilding, setMapCenter, setMapReady, setMapZoom } from '$lib/stores/map';
  import { buildingFilterRules } from '$lib/stores/filters';
  import { searchState } from '$lib/stores/search';
  import { encodeOsmFeatureId, getFeatureIdentity, getSelectionFilter, parseOsmKey } from './selection-utils';
  import { EMPTY_LAYER_FILTER, hashFilterExpression } from './filter-highlight-utils';

  const dispatch = createEventDispatcher();
  const LIGHT_MAP_STYLE_URL = '/styles/positron-custom.json';
  const DARK_MAP_STYLE_URL = '/styles/dark-matter-custom.json';
  const BUILDINGS_SOURCE_ID = 'local-buildings';
  const BUILDINGS_FILL_LAYER_ID = 'local-buildings-fill';
  const BUILDINGS_LINE_LAYER_ID = 'local-buildings-line';
  const FILTER_HIGHLIGHT_FILL_LAYER_ID = 'buildings-filter-highlight-fill';
  const FILTER_HIGHLIGHT_LINE_LAYER_ID = 'buildings-filter-highlight-outline';
  const FILTER_HIGHLIGHT_MODE = 'feature-state';
  const SELECTED_FILL_LAYER_ID = 'selected-building-fill';
  const SELECTED_LINE_LAYER_ID = 'selected-building-line';
  const SEARCH_RESULTS_SOURCE_ID = 'search-results-points';
  const SEARCH_RESULTS_LAYER_ID = 'search-results-points-layer';
  const SEARCH_RESULTS_CLUSTER_LAYER_ID = 'search-results-clusters-layer';
  const SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID = 'search-results-clusters-count-layer';
  const CARTO_BUILDING_LAYER_IDS = ['building', 'building-top'];
  const STYLE_OVERLAY_FADE_MS = 260;
  const FILTER_REQUEST_DEBOUNCE_MS = 180;
  const CARTO_SHOW_DELAY_MS = 160;
  const COVERAGE_CACHE_LIMIT = 800;
  const FILTER_RULE_OPS = new Set(['contains', 'equals', 'not_equals', 'starts_with', 'exists', 'not_exists']);
  const FILTER_DATA_CACHE_TTL_MS = 45_000;
  const FILTER_DATA_CACHE_MAX_ITEMS = 25_000;
  const FILTER_DATA_REQUEST_CHUNK_SIZE = 5_000;
  const BUILDING_THEME = {
    light: {
      fillColor: '#a3a3a3',
      fillOpacity: 0.32,
      lineColor: '#bcbcbc',
      lineWidth: 0.9
    },
    dark: {
      fillColor: '#64748b',
      fillOpacity: 0.36,
      lineColor: '#94a3b8',
      lineWidth: 1
    }
  };

  let container;
  let map = null;
  let maplibregl = null;
  let protocol = null;
  let pmtilesArchive = null;
  let pmtilesMinZoom = null;
  let pmtilesMaxZoom = null;
  let themeObserver = null;
  let mapMoveDebounceTimer = null;
  let coverageDebounceTimer = null;
  let cartoShowTimer = null;
  let activeFilterAbortController = null;
  let coverageEvalToken = 0;
  let coverageVisibleState = 'visible';
  let coverageCache = new Map();
  let latestFilterToken = 0;
  let lastSelectedKey = null;
  let lastSearchFitSeq = 0;
  let lastMapFocusRequestId = null;
  let currentMapStyleUrl = LIGHT_MAP_STYLE_URL;
  let runtimeConfig = null;
  let styleTransitionOverlaySrc = null;
  let styleTransitionOverlayVisible = false;
  let styleTransitionTimer = null;
  let lastHandledBuildingClickSig = null;
  let filterRulesDebounceTimer = null;
  let filterRetryTimer = null;
  let filterRetryAttempts = 0;
  let filterErrorMessage = '';
  let filterDebugActive = false;
  let filterDebugExprHash = hashFilterExpression(EMPTY_LAYER_FILTER);
  let filteredFeatureStateKeys = new Set();
  let filterDataByOsmKeyCache = new Map();

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

  function debugFilterLog(eventName, payload = {}) {
    if (!isFilterDebugEnabled()) return;
    console.debug('[map-filter]', eventName, {
      ts: new Date().toISOString(),
      ...payload
    });
  }

  function updateFilterDebugHook({ active = false, expr = EMPTY_LAYER_FILTER, mode = FILTER_HIGHLIGHT_MODE } = {}) {
    if (typeof document === 'undefined') return;
    const exprHash = hashFilterExpression(expr);
    filterDebugActive = Boolean(active);
    filterDebugExprHash = exprHash;
    document.body.dataset.filterActive = active ? 'true' : 'false';
    document.body.dataset.filterHighlightMode = String(mode);
    document.body.dataset.filterExprHash = exprHash;
    window.__MAP_DEBUG__ = window.__MAP_DEBUG__ || {};
    window.__MAP_DEBUG__.filter = {
      active: Boolean(active),
      mode: String(mode),
      exprHash
    };
    if (map) {
      const fillLayerVisible = map.getLayer(FILTER_HIGHLIGHT_FILL_LAYER_ID)
        ? (map.getLayoutProperty(FILTER_HIGHLIGHT_FILL_LAYER_ID, 'visibility') || 'visible')
        : 'missing';
      const lineLayerVisible = map.getLayer(FILTER_HIGHLIGHT_LINE_LAYER_ID)
        ? (map.getLayoutProperty(FILTER_HIGHLIGHT_LINE_LAYER_ID, 'visibility') || 'visible')
        : 'missing';
      window.__MAP_DEBUG__.layersVisibility = {
        [BUILDINGS_FILL_LAYER_ID]: map.getLayoutProperty(BUILDINGS_FILL_LAYER_ID, 'visibility') || 'visible',
        [BUILDINGS_LINE_LAYER_ID]: map.getLayoutProperty(BUILDINGS_LINE_LAYER_ID, 'visibility') || 'visible',
        [FILTER_HIGHLIGHT_FILL_LAYER_ID]: fillLayerVisible,
        [FILTER_HIGHLIGHT_LINE_LAYER_ID]: lineLayerVisible,
        [SELECTED_FILL_LAYER_ID]: map.getLayoutProperty(SELECTED_FILL_LAYER_ID, 'visibility') || 'visible',
        [SELECTED_LINE_LAYER_ID]: map.getLayoutProperty(SELECTED_LINE_LAYER_ID, 'visibility') || 'visible'
      };
    }
  }

  function recordDebugSetFilter(layerId) {
    if (typeof window === 'undefined') return;
    window.__MAP_DEBUG__ = window.__MAP_DEBUG__ || {};
    const current = Array.isArray(window.__MAP_DEBUG__.setFilterLayers)
      ? window.__MAP_DEBUG__.setFilterLayers
      : [];
    const next = [...current, String(layerId)].slice(-80);
    window.__MAP_DEBUG__.setFilterLayers = next;
  }

  function setLocalBuildingFeatureStateByOsmKey(osmKey, state) {
    if (!map) return;
    const parsed = parseOsmKey(osmKey);
    if (!parsed) return;
    const id = encodeOsmFeatureId(parsed.osmType, parsed.osmId);
    if (!Number.isInteger(id) || id <= 0) return;
    const sourceLayer = runtimeConfig?.buildingsPmtiles?.sourceLayer;
    if (!sourceLayer) return;
    try {
      map.setFeatureState(
        {
          source: BUILDINGS_SOURCE_ID,
          sourceLayer,
          id
        },
        state
      );
    } catch {
      // Source/style might be reloading.
    }
  }

  function applyFilteredFeatureState(nextMatchedKeys) {
    const next = new Set((Array.isArray(nextMatchedKeys) ? nextMatchedKeys : []).map((key) => String(key || '').trim()).filter(Boolean));
    for (const key of filteredFeatureStateKeys) {
      if (next.has(key)) continue;
      setLocalBuildingFeatureStateByOsmKey(key, { isFiltered: false });
    }
    for (const key of next) {
      if (filteredFeatureStateKeys.has(key)) continue;
      setLocalBuildingFeatureStateByOsmKey(key, { isFiltered: true });
    }
    filteredFeatureStateKeys = next;
  }

  function clearFilteredFeatureState() {
    applyFilteredFeatureState([]);
    updateFilterDebugHook({
      active: false,
      expr: EMPTY_LAYER_FILTER,
      mode: FILTER_HIGHLIGHT_MODE
    });
  }

  function reapplyFilteredFeatureState() {
    if (filteredFeatureStateKeys.size === 0) return;
    for (const key of filteredFeatureStateKeys) {
      setLocalBuildingFeatureStateByOsmKey(key, { isFiltered: true });
    }
  }

  function getPrimaryBuildingFeature(event) {
    if (!map) return null;
    const searchFeatures = map.queryRenderedFeatures(event.point, {
      layers: [SEARCH_RESULTS_CLUSTER_LAYER_ID, SEARCH_RESULTS_LAYER_ID]
    });
    if (Array.isArray(searchFeatures) && searchFeatures.length > 0) {
      return null;
    }
    const features = map.queryRenderedFeatures(event.point, {
      layers: [BUILDINGS_LINE_LAYER_ID, BUILDINGS_FILL_LAYER_ID]
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
    if (map.getLayer(SELECTED_FILL_LAYER_ID)) {
      map.setFilter(SELECTED_FILL_LAYER_ID, filter);
      recordDebugSetFilter(SELECTED_FILL_LAYER_ID);
    }
    if (map.getLayer(SELECTED_LINE_LAYER_ID)) {
      map.setFilter(SELECTED_LINE_LAYER_ID, filter);
      recordDebugSetFilter(SELECTED_LINE_LAYER_ID);
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
    if (map.getLayer(SELECTED_FILL_LAYER_ID)) {
      map.setFilter(SELECTED_FILL_LAYER_ID, ['==', ['id'], -1]);
      recordDebugSetFilter(SELECTED_FILL_LAYER_ID);
    }
    if (map.getLayer(SELECTED_LINE_LAYER_ID)) {
      map.setFilter(SELECTED_LINE_LAYER_ID, ['==', ['id'], -1]);
      recordDebugSetFilter(SELECTED_LINE_LAYER_ID);
    }
  }

  function applySelectionFromStore(selection) {
    if (!map || !selection?.osmType || !selection?.osmId) return;
    const identity = {
      osmType: selection.osmType,
      osmId: Number(selection.osmId)
    };
    const filter = getSelectionFilter(null, identity);
    if (map.getLayer(SELECTED_FILL_LAYER_ID)) {
      map.setFilter(SELECTED_FILL_LAYER_ID, filter);
      recordDebugSetFilter(SELECTED_FILL_LAYER_ID);
    }
    if (map.getLayer(SELECTED_LINE_LAYER_ID)) {
      map.setFilter(SELECTED_LINE_LAYER_ID, filter);
      recordDebugSetFilter(SELECTED_LINE_LAYER_ID);
    }
  }

  function getSearchItemPoint(item) {
    const lon = Number(item?.lon);
    const lat = Number(item?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    return [lon, lat];
  }

  function buildSearchMarkersGeojson(items) {
    const features = [];
    for (const item of Array.isArray(items) ? items : []) {
      const point = getSearchItemPoint(item);
      if (!point) continue;
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: point
        },
        properties: {
          osm_type: String(item?.osmType || ''),
          osm_id: Number(item?.osmId || 0),
          osm_key: `${String(item?.osmType || '')}/${String(item?.osmId || '')}`
        }
      });
    }
    return {
      type: 'FeatureCollection',
      features
    };
  }

  function updateSearchMarkers(items) {
    if (!map) return;
    const source = map.getSource(SEARCH_RESULTS_SOURCE_ID);
    if (!source) return;
    source.setData(buildSearchMarkersGeojson(items));
  }

  function fitMapToSearchResults(items) {
    if (!map) return;
    const points = (Array.isArray(items) ? items : [])
      .map((item) => getSearchItemPoint(item))
      .filter(Boolean);
    if (points.length === 0) return;

    if (points.length === 1) {
      map.easeTo({
        center: points[0],
        zoom: Math.max(map.getZoom(), 16),
        duration: 450,
        essential: true
      });
      return;
    }

    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const [lon, lat] of points) {
      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
    }

    map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
      padding: { top: 88, right: 30, bottom: 30, left: 30 },
      duration: 500,
      maxZoom: 16.5,
      essential: true
    });
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

  function getCurrentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function getMapStyleForTheme(theme) {
    return theme === 'dark' ? DARK_MAP_STYLE_URL : LIGHT_MAP_STYLE_URL;
  }

  function getBuildingThemePaint(theme) {
    return theme === 'dark' ? BUILDING_THEME.dark : BUILDING_THEME.light;
  }

  function applyBuildingThemePaint(theme) {
    if (!map) return;
    const paint = getBuildingThemePaint(theme);
    if (map.getLayer(BUILDINGS_FILL_LAYER_ID)) {
      map.setPaintProperty(BUILDINGS_FILL_LAYER_ID, 'fill-color', paint.fillColor);
      map.setPaintProperty(BUILDINGS_FILL_LAYER_ID, 'fill-opacity', paint.fillOpacity);
    }
    if (map.getLayer(BUILDINGS_LINE_LAYER_ID)) {
      map.setPaintProperty(BUILDINGS_LINE_LAYER_ID, 'line-color', paint.lineColor);
      map.setPaintProperty(BUILDINGS_LINE_LAYER_ID, 'line-width', paint.lineWidth);
    }
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
    if (!map) return;
    map.off('click', handleMapBuildingClick);
    map.off('click', SEARCH_RESULTS_CLUSTER_LAYER_ID, onSearchClusterClick);
    map.off('click', SEARCH_RESULTS_LAYER_ID, onSearchResultClick);
    map.off('mouseenter', BUILDINGS_FILL_LAYER_ID, onPointerEnter);
    map.off('mouseleave', BUILDINGS_FILL_LAYER_ID, onPointerLeave);
    map.off('mouseenter', BUILDINGS_LINE_LAYER_ID, onPointerEnter);
    map.off('mouseleave', BUILDINGS_LINE_LAYER_ID, onPointerLeave);
    map.off('mouseenter', SEARCH_RESULTS_CLUSTER_LAYER_ID, onPointerEnter);
    map.off('mouseleave', SEARCH_RESULTS_CLUSTER_LAYER_ID, onPointerLeave);
    map.off('mouseenter', SEARCH_RESULTS_LAYER_ID, onPointerEnter);
    map.off('mouseleave', SEARCH_RESULTS_LAYER_ID, onPointerLeave);

    map.on('click', handleMapBuildingClick);
    map.on('click', SEARCH_RESULTS_CLUSTER_LAYER_ID, onSearchClusterClick);
    map.on('click', SEARCH_RESULTS_LAYER_ID, onSearchResultClick);
    map.on('mouseenter', BUILDINGS_FILL_LAYER_ID, onPointerEnter);
    map.on('mouseleave', BUILDINGS_FILL_LAYER_ID, onPointerLeave);
    map.on('mouseenter', BUILDINGS_LINE_LAYER_ID, onPointerEnter);
    map.on('mouseleave', BUILDINGS_LINE_LAYER_ID, onPointerLeave);
    map.on('mouseenter', SEARCH_RESULTS_CLUSTER_LAYER_ID, onPointerEnter);
    map.on('mouseleave', SEARCH_RESULTS_CLUSTER_LAYER_ID, onPointerLeave);
    map.on('mouseenter', SEARCH_RESULTS_LAYER_ID, onPointerEnter);
    map.on('mouseleave', SEARCH_RESULTS_LAYER_ID, onPointerLeave);
  }

  function isBaseLabelLayer(layer) {
    if (!layer || layer.type !== 'symbol') return false;
    const id = String(layer.id || '').toLowerCase();
    // Keep app-owned symbol overlays visible; toggle only base map symbols.
    if (id === SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID) return false;
    if (id.startsWith('search-results-')) return false;
    return true;
  }

  function applyLabelLayerVisibility(visible) {
    if (!map || !map.isStyleLoaded()) return;
    const layers = map.getStyle()?.layers || [];
    const nextVisibility = visible ? 'visible' : 'none';
    for (const layer of layers) {
      if (!isBaseLabelLayer(layer)) continue;
      if (!map.getLayer(layer.id)) continue;
      map.setLayoutProperty(layer.id, 'visibility', nextVisibility);
    }
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

  function normalizeLon(lon) {
    let next = Number(lon);
    while (next < -180) next += 360;
    while (next > 180) next -= 360;
    return next;
  }

  function lonLatToTile(lon, lat, z) {
    const zoom = Math.max(0, Math.floor(Number(z)));
    const latClamped = Math.max(-85.05112878, Math.min(85.05112878, Number(lat)));
    const lngWrapped = normalizeLon(lon);
    const world = 2 ** zoom;
    const xRaw = Math.floor(((lngWrapped + 180) / 360) * world);
    const latRad = (latClamped * Math.PI) / 180;
    const yRaw = Math.floor(((1 - (Math.log(Math.tan(latRad) + (1 / Math.cos(latRad))) / Math.PI)) / 2) * world);
    return {
      z: zoom,
      x: Math.max(0, Math.min(world - 1, xRaw)),
      y: Math.max(0, Math.min(world - 1, yRaw))
    };
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

  function readCoverageCache(key) {
    if (!coverageCache.has(key)) return null;
    const value = coverageCache.get(key);
    coverageCache.delete(key);
    coverageCache.set(key, value);
    return value;
  }

  function writeCoverageCache(key, value) {
    if (coverageCache.has(key)) {
      coverageCache.delete(key);
    }
    coverageCache.set(key, value);
    if (coverageCache.size <= COVERAGE_CACHE_LIMIT) return;
    const oldest = coverageCache.keys().next().value;
    if (oldest != null) coverageCache.delete(oldest);
  }

  async function hasPmtilesTile(tile) {
    if (!pmtilesArchive) return false;
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const cached = readCoverageCache(key);
    if (cached != null) return cached;
    try {
      const entry = await pmtilesArchive.getZxy(tile.z, tile.x, tile.y);
      const exists = Boolean(entry?.data || entry);
      writeCoverageCache(key, exists);
      return exists;
    } catch {
      // Treat transport/runtime errors as unknown to avoid false-positive base-layer flicker.
      return null;
    }
  }

  async function hasPmtilesCoverageAtPoint(lon, lat, startZoom) {
    const minZoom = Number.isInteger(pmtilesMinZoom) ? pmtilesMinZoom : 0;
    for (let z = startZoom; z >= minZoom; z -= 1) {
      const tile = lonLatToTile(lon, lat, z);
      const exists = await hasPmtilesTile(tile);
      if (exists === true) return true;
      if (exists == null) return null;
    }
    return false;
  }

  async function evaluatePmtilesCoverage() {
    if (!map || !map.isStyleLoaded() || !pmtilesArchive) return;
    const token = ++coverageEvalToken;
    const rawZoom = Math.floor(map.getZoom());
    const zoom = Number.isInteger(pmtilesMaxZoom)
      ? Math.min(rawZoom, pmtilesMaxZoom)
      : rawZoom;
    const points = getViewportSamplePoints();
    if (points.length === 0) return;
    let hasUnknownCoverage = false;

    for (const [lon, lat] of points) {
      const exists = await hasPmtilesCoverageAtPoint(lon, lat, zoom);
      if (token !== coverageEvalToken) return;
      if (exists == null) {
        hasUnknownCoverage = true;
        continue;
      }
      if (!exists) {
        queueCartoBuildingsVisibility('visible');
        return;
      }
    }
    if (hasUnknownCoverage) return;
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
    const buildingPaint = getBuildingThemePaint(getCurrentTheme());

    const pmtilesUrl = config.buildingsPmtiles.url.startsWith('http')
      ? config.buildingsPmtiles.url
      : `${window.location.origin}${config.buildingsPmtiles.url.startsWith('/') ? '' : '/'}${config.buildingsPmtiles.url}`;

    if (!map.getSource(BUILDINGS_SOURCE_ID)) {
      map.addSource(BUILDINGS_SOURCE_ID, {
        type: 'vector',
        url: `pmtiles://${pmtilesUrl}`
      });
    }

    if (!map.getSource(SEARCH_RESULTS_SOURCE_ID)) {
      map.addSource(SEARCH_RESULTS_SOURCE_ID, {
        type: 'geojson',
        data: buildSearchMarkersGeojson($searchState.items),
        cluster: true,
        clusterRadius: 48,
        clusterMaxZoom: 16
      });
    }

    if (!map.getLayer(BUILDINGS_FILL_LAYER_ID)) {
      map.addLayer({
        id: BUILDINGS_FILL_LAYER_ID,
        type: 'fill',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': config.buildingsPmtiles.sourceLayer,
        minzoom: 13,
        paint: {
          'fill-color': buildingPaint.fillColor,
          'fill-opacity': buildingPaint.fillOpacity
        }
      });
    }

    if (!map.getLayer(BUILDINGS_LINE_LAYER_ID)) {
      map.addLayer({
        id: BUILDINGS_LINE_LAYER_ID,
        type: 'line',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': config.buildingsPmtiles.sourceLayer,
        minzoom: 13,
        paint: {
          'line-color': buildingPaint.lineColor,
          'line-width': buildingPaint.lineWidth
        }
      });
    }

    if (!map.getLayer(FILTER_HIGHLIGHT_FILL_LAYER_ID)) {
      map.addLayer({
        id: FILTER_HIGHLIGHT_FILL_LAYER_ID,
        type: 'fill',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': config.buildingsPmtiles.sourceLayer,
        minzoom: 13,
        paint: {
          'fill-color': '#f59e0b',
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'isFiltered'], false],
            0.36,
            0
          ]
        }
      });
    }

    if (!map.getLayer(FILTER_HIGHLIGHT_LINE_LAYER_ID)) {
      map.addLayer({
        id: FILTER_HIGHLIGHT_LINE_LAYER_ID,
        type: 'line',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': config.buildingsPmtiles.sourceLayer,
        minzoom: 13,
        paint: {
          'line-color': '#b45309',
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'isFiltered'], false],
            1.8,
            0
          ],
          'line-opacity': [
            'case',
            ['boolean', ['feature-state', 'isFiltered'], false],
            0.95,
            0
          ]
        }
      });
    }

    if (!map.getLayer(SELECTED_FILL_LAYER_ID)) {
      map.addLayer({
        id: SELECTED_FILL_LAYER_ID,
        type: 'fill',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': config.buildingsPmtiles.sourceLayer,
        minzoom: 13,
        filter: ['==', ['id'], -1],
        paint: {
          'fill-color': '#12b4a6',
          'fill-opacity': 0.72
        }
      });
    }

    if (!map.getLayer(SELECTED_LINE_LAYER_ID)) {
      map.addLayer({
        id: SELECTED_LINE_LAYER_ID,
        type: 'line',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': config.buildingsPmtiles.sourceLayer,
        minzoom: 13,
        filter: ['==', ['id'], -1],
        paint: {
          'line-color': '#0b6d67',
          'line-width': 2.2
        }
      });
    }

    if (!map.getLayer(SEARCH_RESULTS_CLUSTER_LAYER_ID)) {
      map.addLayer({
        id: SEARCH_RESULTS_CLUSTER_LAYER_ID,
        type: 'circle',
        source: SEARCH_RESULTS_SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': ['step', ['get', 'point_count'], 16, 12, 19, 30, 22, 60, 26],
          'circle-color': '#1d4ed8',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-opacity': 0.92
        }
      });
    }

    if (!map.getLayer(SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID)) {
      map.addLayer({
        id: SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID,
        type: 'symbol',
        source: SEARCH_RESULTS_SOURCE_ID,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['to-string', ['get', 'point_count']],
          'text-font': ['Open Sans Bold'],
          'text-size': 12
        },
        paint: {
          'text-color': '#ffffff'
        }
      });
    }

    if (!map.getLayer(SEARCH_RESULTS_LAYER_ID)) {
      map.addLayer({
        id: SEARCH_RESULTS_LAYER_ID,
        type: 'circle',
        source: SEARCH_RESULTS_SOURCE_ID,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 14, 6, 16, 7],
          'circle-color': '#2563eb',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-opacity': 0.9
        }
      });
    }

    bindStyleInteractionHandlers();
    applySelectionFromStore($selectedBuilding);
    updateSearchMarkers($searchState.items);
    applyBuildingThemePaint(getCurrentTheme());
    applyLabelLayerVisibility($mapLabelsVisible);
    scheduleCoverageCheck();
    updateFilterDebugHook({
      active: Array.isArray($buildingFilterRules) && $buildingFilterRules.length > 0,
      expr: ['literal', [...filteredFeatureStateKeys].sort()],
      mode: FILTER_HIGHLIGHT_MODE
    });
    reapplyFilteredFeatureState();
  }

  function scheduleFilterRefresh() {
    if (mapMoveDebounceTimer) {
      clearTimeout(mapMoveDebounceTimer);
      mapMoveDebounceTimer = null;
    }
    if (filterRulesDebounceTimer) {
      clearTimeout(filterRulesDebounceTimer);
      filterRulesDebounceTimer = null;
    }
    mapMoveDebounceTimer = setTimeout(() => {
      mapMoveDebounceTimer = null;
      applyBuildingFilters($buildingFilterRules);
    }, FILTER_REQUEST_DEBOUNCE_MS);
  }

  function scheduleFilterRulesRefresh(rules = $buildingFilterRules) {
    if (filterRulesDebounceTimer) {
      clearTimeout(filterRulesDebounceTimer);
      filterRulesDebounceTimer = null;
    }
    filterRulesDebounceTimer = setTimeout(() => {
      filterRulesDebounceTimer = null;
      applyBuildingFilters(rules);
    }, 110);
  }

  function scheduleFilterRetry() {
    if (filterRetryAttempts >= 6) {
      clearFilterHighlight();
      return;
    }
    if (filterRetryTimer) {
      clearTimeout(filterRetryTimer);
      filterRetryTimer = null;
    }
    filterRetryAttempts += 1;
    filterRetryTimer = setTimeout(() => {
      filterRetryTimer = null;
      applyBuildingFilters($buildingFilterRules);
    }, 140);
  }

  function restoreCustomLayersAfterStyleChange() {
    if (!map || !runtimeConfig) return;
    const tryRestore = () => {
      if (!map || !runtimeConfig) return;
      if (!map.isStyleLoaded()) return;
      ensureMapSourcesAndLayers(runtimeConfig);
      applyBuildingThemePaint(getCurrentTheme());
      applyBuildingFilters($buildingFilterRules);
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

  function normalizeTagValue(value) {
    if (value == null) return null;
    if (Array.isArray(value)) return value.join(';');
    return String(value);
  }

  function matchesRule(tags, rule) {
    if (!rule || !rule.key) return true;
    const actualRaw = tags?.[rule.key];
    const actual = normalizeTagValue(actualRaw);
    const hasValue = actual != null && String(actual).trim().length > 0;
    if (rule.op === 'exists') return hasValue;
    if (rule.op === 'not_exists') return !hasValue;
    if (actual == null) return false;
    const left = String(actual).toLowerCase();
    const right = String(rule.value || '').toLowerCase();
    if (rule.op === 'equals') return left === right;
    if (rule.op === 'not_equals') return left !== right;
    if (rule.op === 'starts_with') return left.startsWith(right);
    return left.includes(right);
  }

  function getVisibleBuildingOsmKeys() {
    if (!map) return [];
    const features = map.queryRenderedFeatures({ layers: [BUILDINGS_FILL_LAYER_ID, BUILDINGS_LINE_LAYER_ID] });
    const keys = new Set();
    for (const feature of Array.isArray(features) ? features : []) {
      const identity = getFeatureIdentity(feature);
      if (!identity?.osmType || !Number.isInteger(identity?.osmId)) continue;
      keys.add(`${identity.osmType}/${identity.osmId}`);
    }
    return [...keys];
  }

  function getLoadedSourceBuildingOsmKeys() {
    if (!map || !runtimeConfig?.buildingsPmtiles?.sourceLayer) return [];
    const features = map.querySourceFeatures(BUILDINGS_SOURCE_ID, {
      sourceLayer: runtimeConfig.buildingsPmtiles.sourceLayer
    });
    const keys = new Set();
    for (const feature of Array.isArray(features) ? features : []) {
      const identity = getFeatureIdentity(feature);
      if (!identity?.osmType || !Number.isInteger(identity?.osmId)) continue;
      keys.add(`${identity.osmType}/${identity.osmId}`);
    }
    return [...keys];
  }

  function getFilterCandidateOsmKeys() {
    const renderedKeys = getVisibleBuildingOsmKeys();
    if (renderedKeys.length > 0) return renderedKeys;
    return getLoadedSourceBuildingOsmKeys();
  }

  async function fetchFilterDataByOsmKeys(keys, signal) {
    const normalized = [...new Set((Array.isArray(keys) ? keys : [])
      .map((key) => String(key || '').trim())
      .filter((key) => /^(way|relation)\/\d+$/.test(key))
    )];
    if (normalized.length === 0) return new Map();

    const out = new Map();
    const missing = [];
    const now = Date.now();
    for (const key of normalized) {
      const cached = filterDataByOsmKeyCache.get(key);
      if (cached && (now - cached.cachedAt) <= FILTER_DATA_CACHE_TTL_MS) {
        out.set(key, cached.item);
      } else {
        if (cached) filterDataByOsmKeyCache.delete(key);
        missing.push(key);
      }
    }

    for (let i = 0; i < missing.length; i += FILTER_DATA_REQUEST_CHUNK_SIZE) {
      const chunk = missing.slice(i, i + FILTER_DATA_REQUEST_CHUNK_SIZE);
      const payload = await apiJson('/api/buildings/filter-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: chunk }),
        signal
      });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      for (const item of items) {
        const osmKey = String(item?.osmKey || '').trim();
        if (!osmKey) continue;
        filterDataByOsmKeyCache.set(osmKey, {
          cachedAt: Date.now(),
          item
        });
        while (filterDataByOsmKeyCache.size > FILTER_DATA_CACHE_MAX_ITEMS) {
          const oldestKey = filterDataByOsmKeyCache.keys().next().value;
          if (!oldestKey) break;
          filterDataByOsmKeyCache.delete(oldestKey);
        }
        out.set(osmKey, item);
      }
    }
    return out;
  }

  function clearFilterHighlight() {
    if (!map) return;
    clearFilteredFeatureState();
  }

  async function applyBuildingFilters(rules) {
    if (!map) return;
    const activeRules = Array.isArray(rules) ? rules.filter((r) => r?.key) : [];
    debugFilterLog('filter criteria changed', { rules: activeRules });
    const invalidRule = activeRules.find((rule) => !FILTER_RULE_OPS.has(String(rule?.op || 'contains')));
    if (invalidRule) {
      filterErrorMessage = `Invalid filter operator: ${String(invalidRule.op || '')}`;
      filterRetryAttempts = 0;
      clearFilterHighlight();
      return;
    }
    filterErrorMessage = '';
    if (activeRules.length === 0) {
      filterRetryAttempts = 0;
      clearFilterHighlight();
      return;
    }

    const token = ++latestFilterToken;
    const visibleKeys = getFilterCandidateOsmKeys();
    if (visibleKeys.length === 0) {
      if (map.getZoom() >= 13) {
        scheduleFilterRetry();
      } else {
        clearFilterHighlight();
      }
      return;
    }
    filterRetryAttempts = 0;

    let byKey = new Map();
    if (activeFilterAbortController) {
      activeFilterAbortController.abort();
    }
    activeFilterAbortController = new AbortController();
    const signal = activeFilterAbortController.signal;

    try {
      byKey = await fetchFilterDataByOsmKeys(visibleKeys, signal);
    } catch (error) {
      if (String(error?.name || '').toLowerCase() === 'aborterror') return;
      filterRetryAttempts = 0;
      clearFilterHighlight();
      return;
    } finally {
      if (activeFilterAbortController?.signal === signal) {
        activeFilterAbortController = null;
      }
    }
    if (token !== latestFilterToken) return;

    const matchedOsmKeys = [];
    for (const key of visibleKeys) {
      const item = byKey.get(key);
      if (!item) continue;
      const tags = item?.sourceTags || {};
      const ok = activeRules.every((rule) => matchesRule(tags, rule));
      if (!ok) continue;
      matchedOsmKeys.push(key);
    }

    applyFilteredFeatureState(matchedOsmKeys);
    debugFilterLog('highlight filter updated for N ids', { count: matchedOsmKeys.length });
    updateFilterDebugHook({
      active: matchedOsmKeys.length > 0,
      expr: ['literal', [...new Set(matchedOsmKeys)].sort()],
      mode: FILTER_HIGHLIGHT_MODE
    });
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
    scheduleFilterRulesRefresh(rules);
  }

  $: if (map) {
    updateSearchMarkers($searchState.items);
  }

  $: if (map && $searchState.fitSeq !== lastSearchFitSeq) {
    lastSearchFitSeq = $searchState.fitSeq;
    fitMapToSearchResults($searchState.items);
  }

  $: if (map && $mapFocusRequest && $mapFocusRequest.id !== lastMapFocusRequestId) {
    lastMapFocusRequestId = $mapFocusRequest.id;
    const nextZoom = Number.isFinite(Number($mapFocusRequest.zoom))
      ? Number($mapFocusRequest.zoom)
      : map.getZoom();
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
      const [{ default: maplibreModule }, { PMTiles: PMTilesCtor, Protocol: ProtocolCtor }] = await Promise.all([
        import('maplibre-gl'),
        import('pmtiles')
      ]);
      if (!mountAlive) return;
      maplibregl = maplibreModule;

      const config = getRuntimeConfig();
      runtimeConfig = config;
      protocol = new ProtocolCtor();
      maplibregl.addProtocol('pmtiles', protocol.tile);
      currentMapStyleUrl = getMapStyleForTheme(getCurrentTheme());
      coverageCache = new Map();
      coverageVisibleState = 'visible';

      const pmtilesUrl = config.buildingsPmtiles.url.startsWith('http')
        ? config.buildingsPmtiles.url
        : `${window.location.origin}${config.buildingsPmtiles.url.startsWith('/') ? '' : '/'}${config.buildingsPmtiles.url}`;
      pmtilesArchive = new PMTilesCtor(pmtilesUrl);
      pmtilesArchive.getHeader()
        .then((header) => {
          const headerMinZoom = Number(header?.minZoom);
          const headerMaxZoom = Number(header?.maxZoom);
          pmtilesMinZoom = Number.isInteger(headerMinZoom) ? headerMinZoom : null;
          pmtilesMaxZoom = Number.isInteger(headerMaxZoom) ? headerMaxZoom : null;
          scheduleCoverageCheck();
        })
        .catch(() => {
          pmtilesMinZoom = null;
          pmtilesMaxZoom = null;
        });

      map = new maplibregl.Map({
        container,
        style: currentMapStyleUrl,
        center: [config.mapDefault.lon, config.mapDefault.lat],
        zoom: config.mapDefault.zoom,
        attributionControl: true
      });
      map.addControl(new maplibregl.NavigationControl(), 'top-right');
      map.on('moveend', () => {
        setMapCenter(map.getCenter());
        setMapZoom(map.getZoom());
      });
      map.on('moveend', scheduleFilterRefresh);
      map.on('moveend', scheduleCoverageCheck);
      map.on('move', scheduleCoverageCheck);
      map.on('zoomend', scheduleFilterRefresh);
      map.on('zoomend', () => setMapZoom(map.getZoom()));
      map.on('zoomend', scheduleCoverageCheck);
      map.on('resize', scheduleCoverageCheck);

      map.on('style.load', () => {
        ensureMapSourcesAndLayers(config);
        scheduleFilterRefresh();
      });

      map.on('load', () => {
        setMapCenter(map.getCenter());
        setMapZoom(map.getZoom());
        setMapReady(true);
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
    setMapReady(false);
    setMapCenter(null);
    setMapZoom(null);
    if (themeObserver) {
      themeObserver.disconnect();
      themeObserver = null;
    }
    if (styleTransitionTimer) {
      clearTimeout(styleTransitionTimer);
      styleTransitionTimer = null;
    }
    if (mapMoveDebounceTimer) {
      clearTimeout(mapMoveDebounceTimer);
      mapMoveDebounceTimer = null;
    }
    if (filterRulesDebounceTimer) {
      clearTimeout(filterRulesDebounceTimer);
      filterRulesDebounceTimer = null;
    }
    if (filterRetryTimer) {
      clearTimeout(filterRetryTimer);
      filterRetryTimer = null;
    }
    filterRetryAttempts = 0;
    if (coverageDebounceTimer) {
      clearTimeout(coverageDebounceTimer);
      coverageDebounceTimer = null;
    }
    if (cartoShowTimer) {
      clearTimeout(cartoShowTimer);
      cartoShowTimer = null;
    }
    if (activeFilterAbortController) {
      activeFilterAbortController.abort();
      activeFilterAbortController = null;
    }
    if (map) {
      clearFilteredFeatureState();
    }
    if (map) {
      map.remove();
      map = null;
    }
    runtimeConfig = null;
    if (protocol) {
      protocol?.destroy?.();
      protocol = null;
    }
    pmtilesArchive = null;
    pmtilesMinZoom = null;
    pmtilesMaxZoom = null;
    coverageCache = new Map();
    filterDataByOsmKeyCache = new Map();
    filteredFeatureStateKeys = new Set();
    updateFilterDebugHook({
      active: false,
      expr: EMPTY_LAYER_FILTER
    });
  });
</script>

<div
  class="map-canvas"
  bind:this={container}
  data-filter-active={filterDebugActive ? 'true' : 'false'}
  data-filter-highlight-mode={FILTER_HIGHLIGHT_MODE}
  data-filter-expr-hash={filterDebugExprHash}
></div>
{#if filterErrorMessage}
  <div class="map-filter-error" role="status" aria-live="polite">{filterErrorMessage}</div>
{/if}
{#if styleTransitionOverlaySrc}
  <img
    class:visible={styleTransitionOverlayVisible}
    class="map-style-transition-overlay"
    src={styleTransitionOverlaySrc}
    alt=""
    aria-hidden="true"
  />
{/if}

<style>
  .map-canvas {
    position: fixed;
    inset: 0;
  }

  .map-style-transition-overlay {
    position: fixed;
    inset: 0;
    z-index: 9;
    width: 100%;
    height: 100%;
    object-fit: cover;
    pointer-events: none;
    opacity: 0;
    transition: opacity 260ms ease;
  }

  .map-style-transition-overlay.visible {
    opacity: 1;
  }

  .map-filter-error {
    position: fixed;
    left: 12px;
    bottom: 12px;
    z-index: 10;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(185, 28, 28, 0.9);
    color: #ffffff;
    font-size: 12px;
    line-height: 1.3;
    max-width: min(78vw, 440px);
    pointer-events: none;
  }
</style>
