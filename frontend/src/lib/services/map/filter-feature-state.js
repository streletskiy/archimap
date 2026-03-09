import { EMPTY_LAYER_FILTER } from '$lib/components/map/filter-highlight-utils';
import { setLocalBuildingFeatureStateById } from './map-layer-utils';
import { encodeOsmFeatureId, getNow, nextAnimationFrame, parseOsmKey } from './filter-utils';

export function createFilterFeatureStateManager({
  resolveMap,
  resolveBuildingSourceConfigs,
  requestFilterWorker,
  getLatestFilterToken,
  getFilterDenseBurstEnabled,
  getFilterMoveEndDelayMs,
  patchState,
  debugFilterLog,
  recordFilterTelemetry,
  updateFilterRuntimeStatus,
  updateFilterDebugHook,
  getCurrentPhase,
  highlightMode,
  featureStateChunkSize,
  denseDiffThreshold,
  applyFrameBudgetMs,
  applyDenseFrameBudgetMs,
  applyDenseMaxOpsPerFrame
} = {}) {
  let filteredFeatureStateFeatureIds = new Set();

  function setBuildingFilterFeatureStateById(id, nextState) {
    return setLocalBuildingFeatureStateById({
      map: resolveMap(),
      sourceConfigs: resolveBuildingSourceConfigs(),
      id,
      state: nextState
    });
  }

  async function applyFeatureStatePlanInChunks(plan, token, meta = {}) {
    const workingSet = new Set(filteredFeatureStateFeatureIds);
    const toDisable = Array.isArray(plan?.toDisable) ? plan.toDisable : [];
    const toEnable = Array.isArray(plan?.toEnable) ? plan.toEnable : [];
    const chunkSize = Math.max(120, Number(meta.chunkSize || featureStateChunkSize) || featureStateChunkSize);
    const totalOps = toDisable.length + toEnable.length;
    const denseMode = Boolean(getFilterDenseBurstEnabled?.()) && totalOps >= denseDiffThreshold;
    let disableIndex = 0;
    let enableIndex = 0;
    let setCalls = 0;
    const applyStartedAt = getNow();
    recordFilterTelemetry?.('apply_plan_start', {
      token,
      toDisable: toDisable.length,
      toEnable: toEnable.length,
      delayFromMoveEndMs: getFilterMoveEndDelayMs?.() ?? null
    });

    while (disableIndex < toDisable.length || enableIndex < toEnable.length) {
      if (token !== Number(getLatestFilterToken?.() ?? token)) {
        filteredFeatureStateFeatureIds = workingSet;
        recordFilterTelemetry?.('apply_plan_cancelled', {
          token,
          setCalls,
          partialSize: workingSet.size
        });
        return { cancelled: true, setCalls, elapsedMs: Math.round(getNow() - applyStartedAt) };
      }
      const frameStartedAt = getNow();
      const frameBudgetMs = denseMode ? applyDenseFrameBudgetMs : applyFrameBudgetMs;
      const maxOpsPerFrame = denseMode
        ? applyDenseMaxOpsPerFrame
        : chunkSize;
      let frameOps = 0;
      while (
        frameOps < maxOpsPerFrame &&
        disableIndex < toDisable.length &&
        (getNow() - frameStartedAt) <= frameBudgetMs
      ) {
        const id = toDisable[disableIndex++];
        if (setBuildingFilterFeatureStateById(id, { isFiltered: false })) {
          workingSet.delete(id);
          setCalls += 1;
        }
        frameOps += 1;
      }
      while (
        frameOps < maxOpsPerFrame &&
        enableIndex < toEnable.length &&
        (getNow() - frameStartedAt) <= frameBudgetMs
      ) {
        const id = toEnable[enableIndex++];
        if (setBuildingFilterFeatureStateById(id, { isFiltered: true })) {
          workingSet.add(id);
          setCalls += 1;
        }
        frameOps += 1;
      }
      if (disableIndex < toDisable.length || enableIndex < toEnable.length) {
        await nextAnimationFrame();
      }
    }

    filteredFeatureStateFeatureIds = new Set(Array.isArray(plan?.nextFeatureIds) ? plan.nextFeatureIds : [...workingSet]);
    const elapsedMs = Math.round(getNow() - applyStartedAt);
    patchState?.({
      setFeatureStateCallsLast: setCalls,
      lastApplyDiffMs: elapsedMs
    });
    recordFilterTelemetry?.('apply_plan_finish', {
      token,
      toDisable: toDisable.length,
      toEnable: toEnable.length,
      setCalls,
      elapsedMs,
      denseMode,
      delayFromMoveEndMs: getFilterMoveEndDelayMs?.() ?? null
    });
    return { cancelled: false, setCalls, elapsedMs };
  }

  async function applyFilteredFeatureStateMatches(matches, token, meta = {}) {
    const prevFeatureIds = [...filteredFeatureStateFeatureIds];
    let plan;
    try {
      const workerResponse = await requestFilterWorker('build-apply-plan', {
        prevFeatureIds,
        matches
      });
      plan = {
        toEnable: Array.isArray(workerResponse?.toEnable) ? workerResponse.toEnable : [],
        toDisable: Array.isArray(workerResponse?.toDisable) ? workerResponse.toDisable : [],
        nextFeatureIds: Array.isArray(workerResponse?.nextFeatureIds) ? workerResponse.nextFeatureIds : [],
        total: Number(workerResponse?.total || 0)
      };
    } catch {
      const nextFeatureIds = new Set(Array.isArray(matches?.matchedFeatureIds) ? matches.matchedFeatureIds : []);
      for (const key of Array.isArray(matches?.matchedKeys) ? matches.matchedKeys : []) {
        const parsed = parseOsmKey(key);
        if (!parsed) continue;
        nextFeatureIds.add(encodeOsmFeatureId(parsed.osmType, parsed.osmId));
      }
      const toDisable = [];
      const toEnable = [];
      for (const id of prevFeatureIds) {
        if (!nextFeatureIds.has(id)) toDisable.push(id);
      }
      for (const id of nextFeatureIds) {
        if (!filteredFeatureStateFeatureIds.has(id)) toEnable.push(id);
      }
      plan = {
        toEnable,
        toDisable,
        nextFeatureIds: [...nextFeatureIds],
        total: nextFeatureIds.size
      };
    }
    if (token !== Number(getLatestFilterToken?.() ?? token)) return;

    const applyResult = await applyFeatureStatePlanInChunks(plan, token, meta);
    if (applyResult?.cancelled) return;
    patchState?.({
      lastCount: plan.total,
      setFeatureStateCallsLast: Number(applyResult?.setCalls || 0)
    });
    debugFilterLog?.('apply diff enable/disable', {
      enable: plan.toEnable.length,
      disable: plan.toDisable.length,
      total: plan.total,
      phase: meta.phase || getCurrentPhase?.()
    });
    updateFilterRuntimeStatus?.({
      count: plan.total,
      setFeatureStateCalls: Number(applyResult?.setCalls || 0)
    });
  }

  function clearFilteredFeatureState() {
    let setCalls = 0;
    for (const id of filteredFeatureStateFeatureIds) {
      if (setBuildingFilterFeatureStateById(id, { isFiltered: false })) {
        setCalls += 1;
      }
    }
    filteredFeatureStateFeatureIds = new Set();
    patchState?.({
      lastCount: 0,
      setFeatureStateCallsLast: setCalls
    });
    recordFilterTelemetry?.('filter_state_cleared', { setCalls });
    updateFilterRuntimeStatus?.({
      count: 0,
      setFeatureStateCalls: setCalls
    });
    updateFilterDebugHook?.({
      active: false,
      expr: EMPTY_LAYER_FILTER,
      mode: highlightMode,
      phase: getCurrentPhase?.()
    });
  }

  function reapplyFilteredFeatureState() {
    if (filteredFeatureStateFeatureIds.size === 0) return;
    let setCalls = 0;
    for (const id of filteredFeatureStateFeatureIds) {
      if (setBuildingFilterFeatureStateById(id, { isFiltered: true })) {
        setCalls += 1;
      }
    }
    patchState?.({
      setFeatureStateCallsLast: setCalls
    });
    updateFilterRuntimeStatus?.({
      setFeatureStateCalls: setCalls
    });
  }

  function getFilteredFeatureStateIdsSize() {
    return filteredFeatureStateFeatureIds.size;
  }

  return {
    applyFeatureStatePlanInChunks,
    applyFilteredFeatureStateMatches,
    clearFilteredFeatureState,
    getFilteredFeatureStateIdsSize,
    reapplyFilteredFeatureState,
    setBuildingFilterFeatureStateById
  };
}
