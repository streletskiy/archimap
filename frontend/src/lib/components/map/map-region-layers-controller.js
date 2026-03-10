import {
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
} from '../../services/map/map-layer-utils.js';
import {
  SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID,
  SEARCH_RESULTS_CLUSTER_LAYER_ID,
  SEARCH_RESULTS_LAYER_ID,
  SEARCH_RESULTS_SOURCE_ID
} from '../../services/map/map-search-utils.js';
import { getBuildingThemePaint } from '../../services/map/map-theme-utils.js';
import {
  buildRegionSourceId,
  getActiveRegionPmtiles,
  pointInBounds
} from '../../services/region-pmtiles.js';

const CARTO_SHOW_DELAY_MS = 160;

export function createMapRegionLayersController({
  getMap,
  getRuntimeConfig,
  getCurrentTheme,
  getSearchItems,
  getSelectedBuilding,
  getMapLabelsVisible,
  getBuildingFilterLayers,
  getWindowOrigin,
  onBindStyleInteractionHandlers,
  onApplySelectionFromStore,
  onUpdateSearchMarkers,
  onApplyBuildingThemePaint,
  onApplyLabelLayerVisibility,
  onRefreshFilterDebugState,
  onReapplyFilteredHighlight
} = {}) {
  let activeRegionPmtiles = [];
  let coverageDebounceTimer = null;
  let cartoShowTimer = null;
  let coverageEvalToken = 0;
  let coverageVisibleState = 'visible';

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

  function getCurrentBuildingSourceConfigsSnapshot() {
    return getCurrentBuildingSourceConfigs(activeRegionPmtiles);
  }

  function getMapLayerIdsForRegions(regions = []) {
    return {
      buildingFillLayerIds: getCurrentBuildingsFillLayerIds(regions),
      buildingLineLayerIds: getCurrentBuildingsLineLayerIds(regions),
      filterHighlightFillLayerIds: getCurrentFilterHighlightFillLayerIds(regions),
      filterHighlightLineLayerIds: getCurrentFilterHighlightLineLayerIds(regions),
      selectedFillLayerIds: getCurrentSelectedFillLayerIds(regions),
      selectedLineLayerIds: getCurrentSelectedLineLayerIds(regions)
    };
  }

  function areRegionSetsEqualById(left = [], right = []) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (Number(left[index]?.id) !== Number(right[index]?.id)) return false;
    }
    return true;
  }

  function hasRegionLayersReady(regions = []) {
    const map = getMap?.();
    if (!map) return false;
    const layerIds = getMapLayerIdsForRegions(regions);
    const allLayerIds = [
      ...layerIds.buildingFillLayerIds,
      ...layerIds.buildingLineLayerIds,
      ...layerIds.filterHighlightFillLayerIds,
      ...layerIds.filterHighlightLineLayerIds,
      ...layerIds.selectedFillLayerIds,
      ...layerIds.selectedLineLayerIds
    ];

    for (const region of regions) {
      if (!map.getSource(buildRegionSourceId(region.id))) return false;
    }

    return allLayerIds.every((layerId) => Boolean(map.getLayer(layerId)));
  }

  function hasSearchResultLayersReady() {
    const map = getMap?.();
    if (!map) return false;
    return Boolean(map.getSource(SEARCH_RESULTS_SOURCE_ID))
      && Boolean(map.getLayer(SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID))
      && Boolean(map.getLayer(SEARCH_RESULTS_CLUSTER_LAYER_ID))
      && Boolean(map.getLayer(SEARCH_RESULTS_LAYER_ID));
  }

  function getConfiguredRegionPmtiles(config = getRuntimeConfig?.()) {
    return Array.isArray(config?.buildingRegionsPmtiles) ? config.buildingRegionsPmtiles : [];
  }

  function getViewportActiveRegionPmtiles(config = getRuntimeConfig?.()) {
    const map = getMap?.();
    if (!map) return [];
    return getActiveRegionPmtiles(getConfiguredRegionPmtiles(config), map.getBounds());
  }

  function setCartoBuildingsVisibility(nextVisibility) {
    const map = getMap?.();
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
    const map = getMap?.();
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
    const map = getMap?.();
    if (!map || !map.isStyleLoaded()) return;
    const token = ++coverageEvalToken;
    const runtimeConfig = getRuntimeConfig?.();
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

  function ensureMapSourcesAndLayers(config, { force = false } = {}) {
    const map = getMap?.();
    if (!map) return;
    const theme = getCurrentTheme?.();
    const buildingPaint = getBuildingThemePaint(theme);
    const nextActiveRegions = getViewportActiveRegionPmtiles(config);
    const regionsChanged = !areRegionSetsEqualById(activeRegionPmtiles, nextActiveRegions);
    const searchLayersReady = hasSearchResultLayersReady();
    const regionLayersReady = hasRegionLayersReady(nextActiveRegions);

    if (!force && !regionsChanged && searchLayersReady && regionLayersReady) {
      return;
    }

    const searchLayersChanged = !searchLayersReady;
    ensureSearchResultsSourceAndLayers(map, getSearchItems?.() || []);

    const nextIds = new Set(nextActiveRegions.map((region) => region.id));
    let regionLayersChanged = regionsChanged;
    for (const currentRegion of activeRegionPmtiles) {
      if (nextIds.has(currentRegion.id)) continue;
      removeRegionBuildingSourceAndLayers(map, currentRegion.id);
      regionLayersChanged = true;
    }
    activeRegionPmtiles = nextActiveRegions;
    for (const region of nextActiveRegions) {
      const hadRegionLayers = hasRegionLayersReady([region]);
      ensureRegionBuildingSourceAndLayers({
        map,
        region,
        buildingPaint,
        origin: typeof getWindowOrigin === 'function' ? getWindowOrigin() : ''
      });
      if (!hadRegionLayers) {
        regionLayersChanged = true;
      }
    }
    bringSearchResultsLayersToFront(map);

    onBindStyleInteractionHandlers?.();
    onApplySelectionFromStore?.(getSelectedBuilding?.());
    onUpdateSearchMarkers?.(getSearchItems?.() || []);
    onApplyBuildingThemePaint?.(theme);
    onApplyLabelLayerVisibility?.(getMapLabelsVisible?.());
    scheduleCoverageCheck();
    if (force || searchLayersChanged || regionLayersChanged) {
      const activeFilterLayers = getBuildingFilterLayers?.() || [];
      onRefreshFilterDebugState?.(Array.isArray(activeFilterLayers) && activeFilterLayers.length > 0);
      onReapplyFilteredHighlight?.();
    }
  }

  function syncMapRegionSources() {
    const runtimeConfig = getRuntimeConfig?.();
    if (!getMap?.() || !runtimeConfig) return;
    ensureMapSourcesAndLayers(runtimeConfig);
  }

  function destroy() {
    if (coverageDebounceTimer) {
      clearTimeout(coverageDebounceTimer);
      coverageDebounceTimer = null;
    }
    if (cartoShowTimer) {
      clearTimeout(cartoShowTimer);
      cartoShowTimer = null;
    }
    activeRegionPmtiles = [];
    coverageEvalToken = 0;
    coverageVisibleState = 'visible';
  }

  return {
    destroy,
    ensureMapSourcesAndLayers,
    getActiveRegionPmtiles: () => activeRegionPmtiles,
    getAllCurrentMapLayerIds,
    getCurrentBuildingSourceConfigs: getCurrentBuildingSourceConfigsSnapshot,
    getCurrentMapLayerIds,
    scheduleCoverageCheck,
    syncMapRegionSources
  };
}
