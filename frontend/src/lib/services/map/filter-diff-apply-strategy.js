import {
  EMPTY_LAYER_FILTER,
  applyFilterPaintHighlight,
  normalizeFilterPaintColorGroups
} from '../../components/map/filter-highlight-utils.js';
import { getNow, normalizeLayerIdsSnapshot } from './filter-utils.js';

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

function buildHighlightLayerSignature(layerIds) {
  const fillLayerIds = Array.isArray(layerIds?.filterHighlightFillLayerIds)
    ? layerIds.filterHighlightFillLayerIds
    : [];
  const lineLayerIds = Array.isArray(layerIds?.filterHighlightLineLayerIds)
    ? layerIds.filterHighlightLineLayerIds
    : [];
  return `fill:${fillLayerIds.join(',')}|line:${lineLayerIds.join(',')}`;
}

export function createFilterDiffApplyStrategy({
  resolveMap,
  resolveLayerIds,
  getLatestFilterToken,
  patchState,
  debugFilterLog,
  recordFilterTelemetry,
  updateFilterRuntimeStatus,
  updateFilterDebugHook,
  getCurrentPhase,
  highlightMode
} = {}) {
  let filteredColorGroups = [];
  let filteredFeatureCount = 0;
  let lastAppliedHighlightLayerSignature = '';
  let lastAppliedHighlightActive = false;

  function getHighlightLayerIds() {
    return normalizeLayerIdsSnapshot(resolveLayerIds?.() || {});
  }

  function applyCurrentHighlight(meta = {}) {
    const applyStartedAt = getNow();
    const layerIds = meta.layerIds || getHighlightLayerIds();
    const layerSignature = buildHighlightLayerSignature(layerIds);
    const applyResult = applyFilterPaintHighlight({
      map: resolveMap(),
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
      lineLayerIds: layerIds.filterHighlightLineLayerIds
    });
    lastAppliedHighlightLayerSignature = layerSignature;
    lastAppliedHighlightActive = Boolean(applyResult.active);
    const elapsedMs = Math.round(getNow() - applyStartedAt);
    patchState?.({
      setPaintPropertyCallsLast: Number(applyResult.paintPropertyCalls || 0),
      lastPaintApplyMs: elapsedMs
    });
    recordFilterTelemetry?.('apply_paint_finish', {
      token: meta.token ?? null,
      count: filteredFeatureCount,
      paintPropertyCalls: Number(applyResult.paintPropertyCalls || 0),
      elapsedMs
    });
    return {
      ...applyResult,
      elapsedMs
    };
  }

  async function applyFilteredFeaturePaintGroups(colorGroups, token, meta = {}) {
    if (token !== Number(getLatestFilterToken?.() ?? token)) return;

    const nextColorGroups = normalizeFilterPaintColorGroups(colorGroups);
    const nextFeatureCount = nextColorGroups.reduce((sum, group) => sum + group.ids.length, 0);
    const layerIds = getHighlightLayerIds();
    const nextLayerSignature = buildHighlightLayerSignature(layerIds);

    if (
      areHighlightColorGroupsEqual(filteredColorGroups, nextColorGroups) &&
      nextLayerSignature === lastAppliedHighlightLayerSignature
    ) {
      filteredColorGroups = nextColorGroups;
      filteredFeatureCount = nextFeatureCount;
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

    recordFilterTelemetry?.('apply_paint_start', {
      token,
      count: filteredFeatureCount
    });
    const applyResult = applyCurrentHighlight({
      token,
      layerIds
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
    const applyResult = applyCurrentHighlight({
      previousActive: lastAppliedHighlightActive
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
    const applyResult = applyCurrentHighlight({
      forceStaticPaintProperties: true
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
