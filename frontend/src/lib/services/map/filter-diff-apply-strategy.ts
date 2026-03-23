import {
  EMPTY_LAYER_FILTER,
  applyFilterPaintHighlight,
  normalizeFilterPaintColorGroups
} from '../../components/map/filter-highlight-utils.js';
import {
  BUILDING_FEATURE_KIND,
  BUILDING_PART_FEATURE_KIND,
  buildRegionBuildingLayerFilterExpression
} from './map-layer-utils.js';
import { getNow, normalizeLayerIdsSnapshot } from './filter-utils.js';
import type {
  FilterColorGroup,
  FilterDebugHookInput,
  FilterDiffApplyMeta,
  FilterMapLike,
  FilterPipelineState,
  FilterRuntimeStatus,
  LayerIdsSnapshot
} from './filter-types.js';

function areHighlightColorGroupsEqual(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;

  for (let groupIndex = 0; groupIndex < left.length; groupIndex += 1) {
    const leftGroup = left[groupIndex];
    const rightGroup = right[groupIndex];
    if (String(leftGroup?.color || '') !== String(rightGroup?.color || '')) return false;
    const leftIds = Array.isArray(leftGroup?.ids) ? leftGroup.ids : [];
    const rightIds = Array.isArray(rightGroup?.ids) ? rightGroup.ids : [];
    if (leftIds.length !== rightIds.length) return false;
    for (let idIndex = 0; idIndex < leftIds.length; idIndex += 1) {
      if (Number(leftIds[idIndex]) !== Number(rightIds[idIndex])) return false;
    }
  }

  return true;
}

function buildHighlightLayerSignature(layerIds: LayerIdsSnapshot | null | undefined, buildingPartsVisible = true) {
  const fillLayerIds = Array.isArray(layerIds?.filterHighlightFillLayerIds)
    ? layerIds.filterHighlightFillLayerIds
    : [];
  const lineLayerIds = Array.isArray(layerIds?.filterHighlightLineLayerIds)
    ? layerIds.filterHighlightLineLayerIds
    : [];
  const buildingFillLayerIds = Array.isArray(layerIds?.buildingFillLayerIds)
    ? layerIds.buildingFillLayerIds
    : [];
  const buildingLineLayerIds = Array.isArray(layerIds?.buildingLineLayerIds)
    ? layerIds.buildingLineLayerIds
    : [];
  const buildingPartFillLayerIds = Array.isArray(layerIds?.buildingPartFillLayerIds)
    ? layerIds.buildingPartFillLayerIds
    : [];
  const buildingPartLineLayerIds = Array.isArray(layerIds?.buildingPartLineLayerIds)
    ? layerIds.buildingPartLineLayerIds
    : [];
  const buildingPartFilterHighlightFillLayerIds = Array.isArray(layerIds?.buildingPartFilterHighlightFillLayerIds)
    ? layerIds.buildingPartFilterHighlightFillLayerIds
    : [];
  const buildingPartFilterHighlightLineLayerIds = Array.isArray(layerIds?.buildingPartFilterHighlightLineLayerIds)
    ? layerIds.buildingPartFilterHighlightLineLayerIds
    : [];
  return [
    `fill:${fillLayerIds.join(',')}`,
    `line:${lineLayerIds.join(',')}`,
    `bfill:${buildingFillLayerIds.join(',')}`,
    `bline:${buildingLineLayerIds.join(',')}`,
    `pfill:${buildingPartFillLayerIds.join(',')}`,
    `pline:${buildingPartLineLayerIds.join(',')}`,
    `pffill:${buildingPartFilterHighlightFillLayerIds.join(',')}`,
    `pfln:${buildingPartFilterHighlightLineLayerIds.join(',')}`,
    `parts:${buildingPartsVisible ? 'visible' : 'hidden'}`
  ].join('|');
}

function normalizeFeatureIds(values: Array<number | string | null | undefined> | null | undefined) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
    .sort((left, right) => left - right);
}

function applyBuildingLayerFilters({
  map,
  layerIds,
  featureIds,
  active
}: {
  map: FilterMapLike | null | undefined;
  layerIds: LayerIdsSnapshot;
  featureIds: number[];
  active: boolean;
}) {
  if (!map) return;
  const partFillFilter = buildRegionBuildingLayerFilterExpression({
    featureIds,
    featureKind: 'building_part',
    active
  });
  const partLineFilter = partFillFilter;
  for (const layerId of layerIds.buildingPartFillLayerIds || []) {
    if (!map.getLayer(layerId)) continue;
    map.setFilter(layerId, partFillFilter);
  }
  for (const layerId of layerIds.buildingPartLineLayerIds || []) {
    if (!map.getLayer(layerId)) continue;
    map.setFilter(layerId, partLineFilter);
  }
}

export function createFilterDiffApplyStrategy({
  resolveMap,
  resolveLayerIds,
  getBuildingPartsVisible,
  getLatestFilterToken,
  patchState,
  debugFilterLog,
  recordFilterTelemetry,
  updateFilterRuntimeStatus,
  updateFilterDebugHook,
  getCurrentPhase,
  highlightMode
}: {
  resolveMap?: () => FilterMapLike | null | undefined;
  resolveLayerIds?: () => Partial<LayerIdsSnapshot> | LayerIdsSnapshot | null | undefined;
  getBuildingPartsVisible?: () => boolean | null | undefined;
  getLatestFilterToken?: () => number;
  patchState?: (patch: Partial<FilterPipelineState>) => void;
  debugFilterLog?: (eventName: string, payload?: Record<string, unknown>) => void;
  recordFilterTelemetry?: (eventName: string, payload?: Record<string, unknown>) => void;
  updateFilterRuntimeStatus?: (status: FilterRuntimeStatus) => void;
  updateFilterDebugHook?: (input: FilterDebugHookInput) => void;
  getCurrentPhase?: () => string | null | undefined;
  highlightMode?: string;
} = {}) {
  let filteredColorGroups: FilterColorGroup[] = [];
  let filteredFeatureCount = 0;
  let filteredFeatureIds: number[] = [];
  let lastAppliedHighlightLayerSignature = '';
  let lastAppliedHighlightActive = false;

  function getHighlightLayerIds() {
    return normalizeLayerIdsSnapshot(resolveLayerIds?.() || {});
  }

  function applyCurrentHighlight(meta: FilterDiffApplyMeta = {}) {
    const applyStartedAt = getNow();
    const map = resolveMap?.();
    const layerIds = meta.layerIds || getHighlightLayerIds();
    const buildingPartsVisible = Boolean(meta.buildingPartsVisible ?? getBuildingPartsVisible?.() ?? true);
    const nextFeatureIds = normalizeFeatureIds(meta.featureIds || filteredFeatureIds);
    const layerSignature = buildHighlightLayerSignature(layerIds, buildingPartsVisible);

    applyBuildingLayerFilters({
      map,
      layerIds,
      featureIds: nextFeatureIds,
      active: nextFeatureIds.length > 0
    });

    const buildingHighlightResult = applyFilterPaintHighlight({
      map,
      normalizedColorGroups: filteredColorGroups,
      previousActive: Boolean(meta.previousActive ?? lastAppliedHighlightActive),
      forceStaticPaintProperties: Boolean(
        meta.forceStaticPaintProperties
        || (
          meta.forceStaticPaintProperties == null
          && layerSignature !== lastAppliedHighlightLayerSignature
        )
      ),
      fillLayerIds: layerIds.filterHighlightFillLayerIds,
      lineLayerIds: layerIds.filterHighlightLineLayerIds,
      additionalFilterExpression: buildRegionBuildingLayerFilterExpression({
        featureKind: BUILDING_FEATURE_KIND,
        active: false
      })
    });
    const buildingPartHighlightResult = applyFilterPaintHighlight({
      map,
      normalizedColorGroups: filteredColorGroups,
      previousActive: Boolean(meta.previousActive ?? lastAppliedHighlightActive),
      forceStaticPaintProperties: Boolean(
        meta.forceStaticPaintProperties
        || (
          meta.forceStaticPaintProperties == null
          && layerSignature !== lastAppliedHighlightLayerSignature
        )
      ),
      fillLayerIds: layerIds.buildingPartFilterHighlightFillLayerIds,
      lineLayerIds: layerIds.buildingPartFilterHighlightLineLayerIds,
      additionalFilterExpression: buildRegionBuildingLayerFilterExpression({
        featureKind: BUILDING_PART_FEATURE_KIND,
        active: false
      })
    });
    lastAppliedHighlightLayerSignature = layerSignature;
    const paintPropertyCalls = Number(buildingHighlightResult.paintPropertyCalls || 0)
      + Number(buildingPartHighlightResult.paintPropertyCalls || 0);
    const active = Boolean(buildingHighlightResult.active || buildingPartHighlightResult.active);
    lastAppliedHighlightActive = active;
    const elapsedMs = Math.round(getNow() - applyStartedAt);
    patchState?.({
      setPaintPropertyCallsLast: paintPropertyCalls,
      lastPaintApplyMs: elapsedMs
    });
    recordFilterTelemetry?.('apply_paint_finish', {
      token: meta.token ?? null,
      count: filteredFeatureCount,
      paintPropertyCalls,
      elapsedMs
    });
    return {
      ...buildingHighlightResult,
      active,
      paintPropertyCalls,
      elapsedMs
    };
  }

  async function applyFilteredFeaturePaintGroups(
    colorGroups: FilterColorGroup[] | null | undefined,
    token: number,
    meta: FilterDiffApplyMeta = {}
  ) {
    if (token !== Number(getLatestFilterToken?.() ?? token)) return;

    const nextColorGroups = normalizeFilterPaintColorGroups(colorGroups);
    const layerIds = getHighlightLayerIds();
    const buildingPartsVisible = Boolean(meta.buildingPartsVisible ?? getBuildingPartsVisible?.() ?? true);
    const normalizedFeatureIds = normalizeFeatureIds(
      meta.matchedFeatureIds || nextColorGroups.flatMap((group) => Array.isArray(group?.ids) ? group.ids : [])
    );
    const nextFeatureCount = normalizedFeatureIds.length;
    const nextLayerSignature = buildHighlightLayerSignature(layerIds, buildingPartsVisible);

    if (
      areHighlightColorGroupsEqual(filteredColorGroups, nextColorGroups) &&
      filteredFeatureIds.length === normalizedFeatureIds.length &&
      filteredFeatureIds.every((id, index) => id === normalizedFeatureIds[index]) &&
      nextLayerSignature === lastAppliedHighlightLayerSignature
    ) {
      filteredColorGroups = nextColorGroups;
      filteredFeatureCount = nextFeatureCount;
      filteredFeatureIds = normalizedFeatureIds;
      patchState?.({
        lastCount: filteredFeatureCount,
        setPaintPropertyCallsLast: 0,
        lastPaintApplyMs: 0
      });
      recordFilterTelemetry?.('apply_paint_skipped', {
        token,
        count: filteredFeatureCount
      });
      debugFilterLog?.('skip paint expression apply', {
        groups: filteredColorGroups.length,
        total: filteredFeatureCount,
        phase: meta.phase || getCurrentPhase?.()
      });
      updateFilterRuntimeStatus?.({
        count: filteredFeatureCount,
        setPaintPropertyCalls: 0
      });
      return;
    }

    filteredColorGroups = nextColorGroups;
    filteredFeatureCount = nextFeatureCount;
    filteredFeatureIds = normalizedFeatureIds;

    recordFilterTelemetry?.('apply_paint_start', {
      token,
      count: filteredFeatureCount
    });
    const applyResult = applyCurrentHighlight({
      token,
      layerIds,
      buildingPartsVisible,
      featureIds: filteredFeatureIds
    });

    patchState?.({
      lastCount: filteredFeatureCount,
      setPaintPropertyCallsLast: Number(applyResult.paintPropertyCalls || 0),
      lastPaintApplyMs: Number(applyResult.elapsedMs || 0)
    });
    debugFilterLog?.('apply paint expression', {
      groups: filteredColorGroups.length,
      total: filteredFeatureCount,
      phase: meta.phase || getCurrentPhase?.()
    });
    updateFilterRuntimeStatus?.({
      count: filteredFeatureCount,
      setPaintPropertyCalls: Number(applyResult.paintPropertyCalls || 0)
    });
  }

  function clearFilteredHighlight() {
    filteredColorGroups = [];
    filteredFeatureCount = 0;
    filteredFeatureIds = [];
    const layerIds = getHighlightLayerIds();
    applyBuildingLayerFilters({
      map: resolveMap?.(),
      layerIds,
      featureIds: [],
      active: false
    });
    const applyResult = applyCurrentHighlight({
      previousActive: lastAppliedHighlightActive,
      layerIds,
      buildingPartsVisible: Boolean(getBuildingPartsVisible?.() ?? true),
      featureIds: []
    });
    patchState?.({
      lastCount: 0,
      setPaintPropertyCallsLast: Number(applyResult.paintPropertyCalls || 0),
      lastPaintApplyMs: Number(applyResult.elapsedMs || 0)
    });
    recordFilterTelemetry?.('filter_highlight_cleared', {
      paintPropertyCalls: Number(applyResult.paintPropertyCalls || 0)
    });
    updateFilterRuntimeStatus?.({
      count: 0,
      setPaintPropertyCalls: Number(applyResult.paintPropertyCalls || 0)
    });
    updateFilterDebugHook?.({
      active: false,
      expr: EMPTY_LAYER_FILTER,
      mode: highlightMode,
      phase: getCurrentPhase?.()
    });
  }

  function reapplyFilteredHighlight() {
    const layerIds = getHighlightLayerIds();
    const applyResult = applyCurrentHighlight({
      forceStaticPaintProperties: true,
      layerIds,
      buildingPartsVisible: Boolean(getBuildingPartsVisible?.() ?? true),
      featureIds: filteredFeatureIds
    });
    patchState?.({
      setPaintPropertyCallsLast: Number(applyResult.paintPropertyCalls || 0),
      lastPaintApplyMs: Number(applyResult.elapsedMs || 0)
    });
    updateFilterRuntimeStatus?.({
      setPaintPropertyCalls: Number(applyResult.paintPropertyCalls || 0)
    });
  }

  function getFilteredFeatureCount() {
    return filteredFeatureCount;
  }

  return {
    applyFilteredFeaturePaintGroups,
    clearFilteredHighlight,
    getFilteredFeatureCount,
    reapplyFilteredHighlight
  };
}
