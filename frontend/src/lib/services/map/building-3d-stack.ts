// Stable public entrypoint for the building rendering stack.
// Callers should prefer this facade so the implementation can be swapped later
// without a broad import rewrite.
export * from './map-3d-utils.js';
import { BUILDING_RENDERER_KIND, getMapLibreBuildingRenderer } from './building-renderer-maplibre.js';
export type { BuildingRendererBackend } from './building-renderer-maplibre.js';
export {
  BUILDING_FEATURE_KIND,
  BUILDING_PART_FEATURE_KIND,
  BUILDING_REMAINDER_FEATURE_KIND,
  OVERPASS_BUILDING_SOURCE_ID,
  bindMapInteractionHandlers,
  buildRegionBuildingHighlightFilterExpression,
  buildRegionBuildingLayerFilterExpression,
  buildVisibleBuildingSelectionScopeExpression,
  getBasemapBuildingLayerIds,
  getBasemapSuppressedLayerIds,
  getCurrentBuildingHoverExtrusionLayerIds,
  getCurrentBuildingHoverFillLayerIds,
  getCurrentBuildingHoverLineLayerIds,
  getCurrentBuildingPartExtrusionLayerIds,
  getCurrentBuildingPartFillLayerIds,
  getCurrentBuildingPartFilterHighlightExtrusionLayerIds,
  getCurrentBuildingPartFilterHighlightFillLayerIds,
  getCurrentBuildingPartFilterHighlightLineLayerIds,
  getCurrentBuildingPartLineLayerIds,
  getCurrentBuildingsExtrusionLayerIds,
  getCurrentBuildingsFillLayerIds,
  getCurrentBuildingsLineLayerIds,
  getCurrentBuildingSourceConfigs,
  getCurrentFilterHighlightExtrusionLayerIds,
  getCurrentFilterHighlightFillLayerIds,
  getCurrentFilterHighlightLineLayerIds,
  getCurrentOverpassBuildingHoverExtrusionLayerIds,
  getCurrentOverpassBuildingHoverFillLayerIds,
  getCurrentOverpassBuildingHoverLineLayerIds,
  getCurrentOverpassBuildingPartExtrusionLayerIds,
  getCurrentOverpassBuildingPartFillLayerIds,
  getCurrentOverpassBuildingPartFilterHighlightExtrusionLayerIds,
  getCurrentOverpassBuildingPartFilterHighlightFillLayerIds,
  getCurrentOverpassBuildingPartFilterHighlightLineLayerIds,
  getCurrentOverpassBuildingPartLineLayerIds,
  getCurrentOverpassBuildingsExtrusionLayerIds,
  getCurrentOverpassBuildingsFillLayerIds,
  getCurrentOverpassBuildingsLineLayerIds,
  getCurrentOverpassFilterHighlightExtrusionLayerIds,
  getCurrentOverpassFilterHighlightFillLayerIds,
  getCurrentOverpassFilterHighlightLineLayerIds,
  getCurrentOverpassSelectedExtrusionLayerIds,
  getCurrentOverpassSelectedFillLayerIds,
  getCurrentOverpassSelectedLineLayerIds,
  getRegionLayerIds,
  getCurrentSelectedExtrusionLayerIds,
  getCurrentSelectedFillLayerIds,
  getCurrentSelectedLineLayerIds
} from './map-layer-utils.js';

const buildingRenderer = getMapLibreBuildingRenderer();

export { BUILDING_RENDERER_KIND };

export function getBuildingRendererBackend() {
  return buildingRenderer;
}

export function applyBuildingPartsLayerVisibility(options) {
  return buildingRenderer.applyBuildingPartsLayerVisibility(options);
}

export function applyBuildingThemePaint(options) {
  return buildingRenderer.applyBuildingThemePaint(options);
}

export function ensureOverpassBuildingSourceAndLayers(options) {
  return buildingRenderer.ensureOverpassBuildingSourceAndLayers(options);
}

export function ensureRegionBuildingSourceAndLayers(options) {
  return buildingRenderer.ensureRegionBuildingSourceAndLayers(options);
}

export function removeRegionBuildingSourceAndLayers(map, regionId) {
  return buildingRenderer.removeRegionBuildingSourceAndLayers(map, regionId);
}
