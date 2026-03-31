import {
  bringBaseLabelLayersAboveCustomLayers,
  bringSearchResultsLayersToFront,
  ensureRegionBuildingSourceAndLayers,
  ensureSearchResultsSourceAndLayers,
  getBasemapBuildingLayerIds,
  getBasemapSuppressedLayerIds,
  getCurrentBuildingSourceConfigs,
  getCurrentBuildingsFillLayerIds,
  getCurrentBuildingsLineLayerIds,
  getCurrentBuildingPartFillLayerIds,
  getCurrentBuildingPartLineLayerIds,
  getCurrentBuildingPartFilterHighlightFillLayerIds,
  getCurrentBuildingPartFilterHighlightLineLayerIds,
  getCurrentBuildingHoverFillLayerIds,
  getCurrentBuildingHoverLineLayerIds,
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
import { getBuildingHoverThemePaint, getBuildingThemePaint } from '../../services/map/map-theme-utils.js';
import {
  buildRegionSourceId,
  getActiveRegionPmtiles,
  pointInBounds
} from '../../services/region-pmtiles.js';
import type {
  FilterBuildingSourceConfig,
  FilterMapLike
} from '../../services/map/filter-types.js';

const CARTO_SHOW_DELAY_MS = 160;

type RegionLike = {
  id?: number | string;
  bounds?: unknown;
} & Record<string, unknown>;

type RuntimeConfigLike = {
  buildingRegionsPmtiles?: RegionLike[];
  basemap?: {
    provider?: string;
  };
};

type MapRegionLayersControllerOptions = {
  getMap?: () => FilterMapLike | null | undefined;
  getRuntimeConfig?: () => RuntimeConfigLike | null | undefined;
  getCurrentTheme?: () => unknown;
  getSearchItems?: () => unknown[];
  getSelectedBuilding?: () => unknown;
  getMapLabelsVisible?: () => boolean | null | undefined;
  getBuildingPartsVisible?: () => boolean | null | undefined;
  getBuildingFilterLayers?: () => unknown[];
  getWindowOrigin?: () => string;
  onBindStyleInteractionHandlers?: () => void;
  onApplySelectionFromStore?: (selection: unknown) => void;
  onUpdateSearchMarkers?: (items: unknown[]) => void;
  onApplyBuildingThemePaint?: (theme: unknown) => void;
  onApplyLabelLayerVisibility?: (visible: boolean | null | undefined) => void;
  onApplyBuildingPartsLayerVisibility?: () => void;
  onRefreshHoverFromPointer?: () => void;
  onRefreshFilterDebugState?: (active: boolean) => void;
  onReapplyFilteredHighlight?: () => void;
};

export function createMapRegionLayersController({
  getMap,
  getRuntimeConfig,
  getCurrentTheme,
  getSearchItems,
  getSelectedBuilding,
  getMapLabelsVisible,
  getBuildingPartsVisible,
  getBuildingFilterLayers,
  getWindowOrigin,
  onBindStyleInteractionHandlers,
  onApplySelectionFromStore,
  onUpdateSearchMarkers,
  onApplyBuildingThemePaint,
  onApplyLabelLayerVisibility,
  onApplyBuildingPartsLayerVisibility,
  onRefreshHoverFromPointer,
  onRefreshFilterDebugState,
  onReapplyFilteredHighlight
}: MapRegionLayersControllerOptions = {}) {
  let activeRegionPmtiles: RegionLike[] = [];
  let coverageDebounceTimer = null;
  let basemapShowTimer = null;
  let coverageEvalToken = 0;
  let coverageVisibleState = 'visible';

  function getCurrentMapLayerIds() {
    return {
      buildingFillLayerIds: getCurrentBuildingsFillLayerIds(activeRegionPmtiles),
      buildingLineLayerIds: getCurrentBuildingsLineLayerIds(activeRegionPmtiles),
      buildingPartFillLayerIds: getCurrentBuildingPartFillLayerIds(activeRegionPmtiles),
      buildingPartLineLayerIds: getCurrentBuildingPartLineLayerIds(activeRegionPmtiles),
      buildingPartFilterHighlightFillLayerIds: getCurrentBuildingPartFilterHighlightFillLayerIds(activeRegionPmtiles),
      buildingPartFilterHighlightLineLayerIds: getCurrentBuildingPartFilterHighlightLineLayerIds(activeRegionPmtiles),
      buildingHoverFillLayerIds: getCurrentBuildingHoverFillLayerIds(activeRegionPmtiles),
      buildingHoverLineLayerIds: getCurrentBuildingHoverLineLayerIds(activeRegionPmtiles),
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
      ...layerIds.buildingPartFillLayerIds,
      ...layerIds.buildingPartLineLayerIds,
      ...layerIds.filterHighlightFillLayerIds,
      ...layerIds.filterHighlightLineLayerIds,
      ...layerIds.buildingPartFilterHighlightFillLayerIds,
      ...layerIds.buildingPartFilterHighlightLineLayerIds,
      ...layerIds.buildingHoverFillLayerIds,
      ...layerIds.buildingHoverLineLayerIds,
      ...layerIds.selectedFillLayerIds,
      ...layerIds.selectedLineLayerIds
    ];
  }

  function getCurrentBuildingSourceConfigsSnapshot(): FilterBuildingSourceConfig[] {
    return getCurrentBuildingSourceConfigs(activeRegionPmtiles);
  }

  function getMapLayerIdsForRegions(regions: RegionLike[] = []) {
    return {
      buildingFillLayerIds: getCurrentBuildingsFillLayerIds(regions),
      buildingLineLayerIds: getCurrentBuildingsLineLayerIds(regions),
      buildingPartFillLayerIds: getCurrentBuildingPartFillLayerIds(regions),
      buildingPartLineLayerIds: getCurrentBuildingPartLineLayerIds(regions),
      buildingPartFilterHighlightFillLayerIds: getCurrentBuildingPartFilterHighlightFillLayerIds(regions),
      buildingPartFilterHighlightLineLayerIds: getCurrentBuildingPartFilterHighlightLineLayerIds(regions),
      buildingHoverFillLayerIds: getCurrentBuildingHoverFillLayerIds(regions),
      buildingHoverLineLayerIds: getCurrentBuildingHoverLineLayerIds(regions),
      filterHighlightFillLayerIds: getCurrentFilterHighlightFillLayerIds(regions),
      filterHighlightLineLayerIds: getCurrentFilterHighlightLineLayerIds(regions),
      selectedFillLayerIds: getCurrentSelectedFillLayerIds(regions),
      selectedLineLayerIds: getCurrentSelectedLineLayerIds(regions)
    };
  }

  function areRegionSetsEqualById(left: RegionLike[] = [], right: RegionLike[] = []) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (Number(left[index]?.id) !== Number(right[index]?.id)) return false;
    }
    return true;
  }

  function hasRegionLayersReady(regions: RegionLike[] = []) {
    const map = getMap?.();
    if (!map) return false;
    const layerIds = getMapLayerIdsForRegions(regions);
    const allLayerIds = [
      ...layerIds.buildingFillLayerIds,
      ...layerIds.buildingLineLayerIds,
      ...layerIds.buildingPartFillLayerIds,
      ...layerIds.buildingPartLineLayerIds,
      ...layerIds.filterHighlightFillLayerIds,
      ...layerIds.filterHighlightLineLayerIds,
      ...layerIds.buildingPartFilterHighlightFillLayerIds,
      ...layerIds.buildingPartFilterHighlightLineLayerIds,
      ...layerIds.buildingHoverFillLayerIds,
      ...layerIds.buildingHoverLineLayerIds,
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

  function getConfiguredRegionPmtiles(config: RuntimeConfigLike | null | undefined = getRuntimeConfig?.()) {
    return Array.isArray(config?.buildingRegionsPmtiles) ? config.buildingRegionsPmtiles : [];
  }

  function getViewportActiveRegionPmtiles(config: RuntimeConfigLike | null | undefined = getRuntimeConfig?.()) {
    const map = getMap?.();
    if (!map) return [];
    return getActiveRegionPmtiles(getConfiguredRegionPmtiles(config), map.getBounds());
  }

  function getBasemapProvider() {
    return String(getRuntimeConfig?.()?.basemap?.provider || '').trim().toLowerCase() === 'maptiler'
      ? 'maptiler'
      : 'carto';
  }

  function setBasemapBuildingsVisibility(nextVisibility) {
    const map = getMap?.();
    if (!map || !map.isStyleLoaded()) return;
    const basemapProvider = getBasemapProvider();
    for (const layerId of getBasemapSuppressedLayerIds(basemapProvider)) {
      if (!map.getLayer(layerId)) continue;
      map.setLayoutProperty(layerId, 'visibility', 'none');
    }
    if (coverageVisibleState === nextVisibility) return;
    for (const layerId of getBasemapBuildingLayerIds(basemapProvider)) {
      if (!map.getLayer(layerId)) continue;
      map.setLayoutProperty(layerId, 'visibility', nextVisibility);
    }
    coverageVisibleState = nextVisibility;
  }

  function queueBasemapBuildingsVisibility(nextVisibility) {
    if (nextVisibility === 'none') {
      if (basemapShowTimer) {
        clearTimeout(basemapShowTimer);
        basemapShowTimer = null;
      }
      setBasemapBuildingsVisibility('none');
      return;
    }
    if (basemapShowTimer) {
      clearTimeout(basemapShowTimer);
    }
    basemapShowTimer = setTimeout(() => {
      basemapShowTimer = null;
      setBasemapBuildingsVisibility('visible');
    }, CARTO_SHOW_DELAY_MS);
  }

  function getViewportSamplePoints() {
    const map = getMap?.();
    if (!map) return [];
    const bounds = map.getBounds() as {
      getWest?: () => number;
      getEast?: () => number;
      getSouth?: () => number;
      getNorth?: () => number;
    } | null | undefined;
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
      queueBasemapBuildingsVisibility('visible');
      return;
    }
    const points = getViewportSamplePoints();
    if (points.length === 0) return;
    for (const [lon, lat] of points) {
      if (token !== coverageEvalToken) return;
      const covered = regions.some((region) => pointInBounds(lon, lat, region.bounds));
      if (!covered) {
        queueBasemapBuildingsVisibility('visible');
        return;
      }
    }
    queueBasemapBuildingsVisibility('none');
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

  function ensureMapSourcesAndLayers(
    config: RuntimeConfigLike,
    { force = false }: { force?: boolean } = {}
  ) {
    const map = getMap?.();
    if (!map) return;
    const theme = getCurrentTheme?.();
    const buildingPaint = getBuildingThemePaint(theme);
    const hoverPaint = getBuildingHoverThemePaint(theme);
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
    const currentBuildingFilters = getBuildingFilterLayers?.() || [];
    const hasActiveBuildingFilters = Array.isArray(currentBuildingFilters) && currentBuildingFilters.length > 0;
    const partsVisible = Boolean(getBuildingPartsVisible?.() ?? true);
    for (const region of nextActiveRegions) {
      const hadRegionLayers = hasRegionLayersReady([region]);
      ensureRegionBuildingSourceAndLayers({
        map,
        region,
        buildingPaint,
        hoverPaint,
        origin: typeof getWindowOrigin === 'function' ? getWindowOrigin() : '',
        buildingPartsVisible: partsVisible,
        buildingPartHighlightVisible: partsVisible || hasActiveBuildingFilters
      });
      if (!hadRegionLayers) {
        regionLayersChanged = true;
      }
    }
    bringSearchResultsLayersToFront(map);
    bringBaseLabelLayersAboveCustomLayers(map);

    onBindStyleInteractionHandlers?.();
    onApplySelectionFromStore?.(getSelectedBuilding?.());
    onUpdateSearchMarkers?.(getSearchItems?.() || []);
    onApplyBuildingThemePaint?.(theme);
    onApplyLabelLayerVisibility?.(getMapLabelsVisible?.());
    onApplyBuildingPartsLayerVisibility?.();
    onRefreshHoverFromPointer?.();
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
    if (basemapShowTimer) {
      clearTimeout(basemapShowTimer);
      basemapShowTimer = null;
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
