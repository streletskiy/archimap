import {
  bringBaseLabelLayersAboveCustomLayers,
  bringSearchResultsLayersToFront,
  ensureRegionBuildingSourceAndLayers,
  ensureSearchResultsSourceAndLayers,
  getBasemapBuildingLayerIds,
  getBasemapSuppressedLayerIds,
  getCurrentBuildingsExtrusionLayerIds,
  getCurrentBuildingSourceConfigs,
  getCurrentBuildingsFillLayerIds,
  getCurrentBuildingsLineLayerIds,
  getCurrentBuildingPartExtrusionLayerIds,
  getCurrentBuildingPartFillLayerIds,
  getCurrentBuildingPartLineLayerIds,
  getCurrentBuildingPartFilterHighlightExtrusionLayerIds,
  getCurrentBuildingPartFilterHighlightFillLayerIds,
  getCurrentBuildingPartFilterHighlightLineLayerIds,
  getCurrentBuildingHoverExtrusionLayerIds,
  getCurrentBuildingHoverFillLayerIds,
  getCurrentBuildingHoverLineLayerIds,
  getCurrentFilterHighlightExtrusionLayerIds,
  getCurrentFilterHighlightFillLayerIds,
  getCurrentFilterHighlightLineLayerIds,
  getCurrentSelectedExtrusionLayerIds,
  getCurrentSelectedFillLayerIds,
  getCurrentSelectedLineLayerIds,
  removeRegionBuildingSourceAndLayers
} from '../../services/map/map-layer-utils.js';
import { normalizeBasemapProvider } from '../../services/map/basemap-config.js';
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
  isViewportCoveredByRegions,
  shouldRenderRegionBuildings
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
  getBuildings3dEnabled?: () => boolean | null | undefined;
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
  getBuildings3dEnabled,
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
      buildingExtrusionLayerIds: getCurrentBuildingsExtrusionLayerIds(activeRegionPmtiles),
      buildingFillLayerIds: getCurrentBuildingsFillLayerIds(activeRegionPmtiles),
      buildingLineLayerIds: getCurrentBuildingsLineLayerIds(activeRegionPmtiles),
      buildingPartExtrusionLayerIds: getCurrentBuildingPartExtrusionLayerIds(activeRegionPmtiles),
      buildingPartFillLayerIds: getCurrentBuildingPartFillLayerIds(activeRegionPmtiles),
      buildingPartLineLayerIds: getCurrentBuildingPartLineLayerIds(activeRegionPmtiles),
      buildingPartFilterHighlightExtrusionLayerIds: getCurrentBuildingPartFilterHighlightExtrusionLayerIds(activeRegionPmtiles),
      buildingPartFilterHighlightFillLayerIds: getCurrentBuildingPartFilterHighlightFillLayerIds(activeRegionPmtiles),
      buildingPartFilterHighlightLineLayerIds: getCurrentBuildingPartFilterHighlightLineLayerIds(activeRegionPmtiles),
      hoverExtrusionLayerIds: getCurrentBuildingHoverExtrusionLayerIds(activeRegionPmtiles),
      hoverFillLayerIds: getCurrentBuildingHoverFillLayerIds(activeRegionPmtiles),
      hoverLineLayerIds: getCurrentBuildingHoverLineLayerIds(activeRegionPmtiles),
      filterHighlightExtrusionLayerIds: getCurrentFilterHighlightExtrusionLayerIds(activeRegionPmtiles),
      filterHighlightFillLayerIds: getCurrentFilterHighlightFillLayerIds(activeRegionPmtiles),
      filterHighlightLineLayerIds: getCurrentFilterHighlightLineLayerIds(activeRegionPmtiles),
      selectedExtrusionLayerIds: getCurrentSelectedExtrusionLayerIds(activeRegionPmtiles),
      selectedFillLayerIds: getCurrentSelectedFillLayerIds(activeRegionPmtiles),
      selectedLineLayerIds: getCurrentSelectedLineLayerIds(activeRegionPmtiles)
    };
  }

  function getAllCurrentMapLayerIds() {
    const layerIds = getCurrentMapLayerIds();
    return [
      ...layerIds.buildingExtrusionLayerIds,
      ...layerIds.buildingFillLayerIds,
      ...layerIds.buildingLineLayerIds,
      ...layerIds.buildingPartExtrusionLayerIds,
      ...layerIds.buildingPartFillLayerIds,
      ...layerIds.buildingPartLineLayerIds,
      ...layerIds.filterHighlightExtrusionLayerIds,
      ...layerIds.filterHighlightFillLayerIds,
      ...layerIds.filterHighlightLineLayerIds,
      ...layerIds.buildingPartFilterHighlightExtrusionLayerIds,
      ...layerIds.buildingPartFilterHighlightFillLayerIds,
      ...layerIds.buildingPartFilterHighlightLineLayerIds,
      ...layerIds.hoverExtrusionLayerIds,
      ...layerIds.hoverFillLayerIds,
      ...layerIds.hoverLineLayerIds,
      ...layerIds.selectedExtrusionLayerIds,
      ...layerIds.selectedFillLayerIds,
      ...layerIds.selectedLineLayerIds
    ];
  }

  function getCurrentBuildingSourceConfigsSnapshot(): FilterBuildingSourceConfig[] {
    return getCurrentBuildingSourceConfigs(activeRegionPmtiles);
  }

  function getMapLayerIdsForRegions(regions: RegionLike[] = []) {
    return {
      buildingExtrusionLayerIds: getCurrentBuildingsExtrusionLayerIds(regions),
      buildingFillLayerIds: getCurrentBuildingsFillLayerIds(regions),
      buildingLineLayerIds: getCurrentBuildingsLineLayerIds(regions),
      buildingPartExtrusionLayerIds: getCurrentBuildingPartExtrusionLayerIds(regions),
      buildingPartFillLayerIds: getCurrentBuildingPartFillLayerIds(regions),
      buildingPartLineLayerIds: getCurrentBuildingPartLineLayerIds(regions),
      buildingPartFilterHighlightExtrusionLayerIds: getCurrentBuildingPartFilterHighlightExtrusionLayerIds(regions),
      buildingPartFilterHighlightFillLayerIds: getCurrentBuildingPartFilterHighlightFillLayerIds(regions),
      buildingPartFilterHighlightLineLayerIds: getCurrentBuildingPartFilterHighlightLineLayerIds(regions),
      hoverExtrusionLayerIds: getCurrentBuildingHoverExtrusionLayerIds(regions),
      hoverFillLayerIds: getCurrentBuildingHoverFillLayerIds(regions),
      hoverLineLayerIds: getCurrentBuildingHoverLineLayerIds(regions),
      filterHighlightExtrusionLayerIds: getCurrentFilterHighlightExtrusionLayerIds(regions),
      filterHighlightFillLayerIds: getCurrentFilterHighlightFillLayerIds(regions),
      filterHighlightLineLayerIds: getCurrentFilterHighlightLineLayerIds(regions),
      selectedExtrusionLayerIds: getCurrentSelectedExtrusionLayerIds(regions),
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
      ...layerIds.buildingExtrusionLayerIds,
      ...layerIds.buildingFillLayerIds,
      ...layerIds.buildingLineLayerIds,
      ...layerIds.buildingPartExtrusionLayerIds,
      ...layerIds.buildingPartFillLayerIds,
      ...layerIds.buildingPartLineLayerIds,
      ...layerIds.filterHighlightExtrusionLayerIds,
      ...layerIds.filterHighlightFillLayerIds,
      ...layerIds.filterHighlightLineLayerIds,
      ...layerIds.buildingPartFilterHighlightExtrusionLayerIds,
      ...layerIds.buildingPartFilterHighlightFillLayerIds,
      ...layerIds.buildingPartFilterHighlightLineLayerIds,
      ...layerIds.hoverExtrusionLayerIds,
      ...layerIds.hoverFillLayerIds,
      ...layerIds.hoverLineLayerIds,
      ...layerIds.selectedExtrusionLayerIds,
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
    if (!shouldRenderRegionBuildings(map.getZoom?.())) {
      return [];
    }
    return getActiveRegionPmtiles(getConfiguredRegionPmtiles(config), map.getBounds());
  }

  function getBasemapProvider() {
    return normalizeBasemapProvider(getRuntimeConfig?.()?.basemap?.provider);
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

  async function evaluatePmtilesCoverage() {
    const map = getMap?.();
    if (!map || !map.isStyleLoaded()) return;
    if (!shouldRenderRegionBuildings(map.getZoom?.())) {
      queueBasemapBuildingsVisibility('visible');
      return;
    }
    const token = ++coverageEvalToken;
    const runtimeConfig = getRuntimeConfig?.();
    const regions = activeRegionPmtiles.length > 0
      ? activeRegionPmtiles
      : getViewportActiveRegionPmtiles(runtimeConfig);
    if (regions.length === 0) {
      queueBasemapBuildingsVisibility('visible');
      return;
    }
    if (token !== coverageEvalToken) return;
    const covered = isViewportCoveredByRegions(regions, map.getBounds(), map.getCenter?.());
    if (!covered) {
      queueBasemapBuildingsVisibility('visible');
      return;
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
    const buildings3dEnabled = Boolean(getBuildings3dEnabled?.() ?? false);
    const partsVisible = Boolean(getBuildingPartsVisible?.() ?? true);
    for (const region of nextActiveRegions) {
      const hadRegionLayers = hasRegionLayersReady([region]);
      ensureRegionBuildingSourceAndLayers({
        map,
        region,
        buildingPaint,
        hoverPaint,
        origin: typeof getWindowOrigin === 'function' ? getWindowOrigin() : '',
        buildings3dEnabled,
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
