import { EMPTY_LAYER_FILTER } from '$lib/components/map/filter-highlight-utils';
import { setLocalBuildingFeatureStateById } from './map-layer-utils';
import { getNow, nextAnimationFrame } from './filter-utils';
import {
  buildFeatureStateEntry,
  buildFeatureStateEntryDiffPlan,
  toFeatureIdSetFromMatches
} from '$lib/components/map/filter-pipeline-utils';

const FILTER_CLEAR_STATE = Object.freeze({
  isFiltered: false,
  filterColor: '#000000'
});

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
  let filteredFeatureStateEntries = new Map();

  function setBuildingFilterFeatureStateById(id, nextState) {
    return setLocalBuildingFeatureStateById({
      map: resolveMap(),
      sourceConfigs: resolveBuildingSourceConfigs(),
      id,
      state: nextState
    });
  }

  async function applyFeatureStatePlanInChunks(plan, token, meta = {}) {
    const workingEntries = new Map(filteredFeatureStateEntries);
    const toDisable = Array.isArray(plan?.toDisable) ? plan.toDisable : [];
    const toEnable = Array.isArray(plan?.toEnable) ? plan.toEnable : [];
    const toUpdate = Array.isArray(plan?.toUpdate) ? plan.toUpdate : [];
    const chunkSize = Math.max(120, Number(meta.chunkSize || featureStateChunkSize) || featureStateChunkSize);
    const totalOps = toDisable.length + toEnable.length + toUpdate.length;
    const denseMode = Boolean(getFilterDenseBurstEnabled?.()) && totalOps >= denseDiffThreshold;
    let disableIndex = 0;
    let enableIndex = 0;
    let updateIndex = 0;
    let setCalls = 0;
    const applyStartedAt = getNow();
    recordFilterTelemetry?.('apply_plan_start', {
      token,
      toDisable: toDisable.length,
      toEnable: toEnable.length,
      toUpdate: toUpdate.length,
      delayFromMoveEndMs: getFilterMoveEndDelayMs?.() ?? null
    });

    while (disableIndex < toDisable.length || enableIndex < toEnable.length || updateIndex < toUpdate.length) {
      if (token !== Number(getLatestFilterToken?.() ?? token)) {
        filteredFeatureStateEntries = workingEntries;
        recordFilterTelemetry?.('apply_plan_cancelled', {
          token,
          setCalls,
          partialSize: workingEntries.size
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
        if (setBuildingFilterFeatureStateById(id, FILTER_CLEAR_STATE)) {
          workingEntries.delete(id);
          setCalls += 1;
        }
        frameOps += 1;
      }
      while (
        frameOps < maxOpsPerFrame &&
        enableIndex < toEnable.length &&
        (getNow() - frameStartedAt) <= frameBudgetMs
      ) {
        const entry = toEnable[enableIndex++];
        if (setBuildingFilterFeatureStateById(entry?.id, entry?.state)) {
          workingEntries.set(entry.id, entry.state);
          setCalls += 1;
        }
        frameOps += 1;
      }
      while (
        frameOps < maxOpsPerFrame &&
        updateIndex < toUpdate.length &&
        (getNow() - frameStartedAt) <= frameBudgetMs
      ) {
        const entry = toUpdate[updateIndex++];
        if (setBuildingFilterFeatureStateById(entry?.id, entry?.state)) {
          workingEntries.set(entry.id, entry.state);
          setCalls += 1;
        }
        frameOps += 1;
      }
      if (disableIndex < toDisable.length || enableIndex < toEnable.length || updateIndex < toUpdate.length) {
        await nextAnimationFrame();
      }
    }

    filteredFeatureStateEntries = new Map(
      (Array.isArray(plan?.nextEntries) ? plan.nextEntries : [...workingEntries.entries()].map(([id, state]) => ({ id, state })))
        .map((entry) => [entry.id, entry.state])
    );
    const elapsedMs = Math.round(getNow() - applyStartedAt);
    patchState?.({
      setFeatureStateCallsLast: setCalls,
      lastApplyDiffMs: elapsedMs
    });
    recordFilterTelemetry?.('apply_plan_finish', {
      token,
      toDisable: toDisable.length,
      toEnable: toEnable.length,
      toUpdate: toUpdate.length,
      setCalls,
      elapsedMs,
      denseMode,
      delayFromMoveEndMs: getFilterMoveEndDelayMs?.() ?? null
    });
    return { cancelled: false, setCalls, elapsedMs };
  }

  async function applyFilteredFeatureStateMatches(matches, token, meta = {}) {
    const filterColor = String(meta?.filterColor || '#f59e0b');
    const nextEntries = [...toFeatureIdSetFromMatches(matches)]
      .map((id) => buildFeatureStateEntry(id, {
        isFiltered: true,
        filterColor
      }))
      .filter(Boolean);
    return applyFilteredFeatureStateEntries(nextEntries, token, meta);
  }

  async function applyFilteredFeatureStateEntries(entries, token, meta = {}) {
    const prevEntries = [...filteredFeatureStateEntries.entries()].map(([id, state]) => ({ id, state }));
    let plan;
    try {
      const workerResponse = await requestFilterWorker('build-apply-plan', {
        prevEntries,
        nextEntries: entries
      });
      plan = {
        toEnable: Array.isArray(workerResponse?.toEnable) ? workerResponse.toEnable : [],
        toDisable: Array.isArray(workerResponse?.toDisable) ? workerResponse.toDisable : [],
        toUpdate: Array.isArray(workerResponse?.toUpdate) ? workerResponse.toUpdate : [],
        nextEntries: Array.isArray(workerResponse?.nextEntries) ? workerResponse.nextEntries : [],
        total: Number(workerResponse?.total || 0)
      };
    } catch {
      plan = buildFeatureStateEntryDiffPlan(prevEntries, entries);
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
    for (const id of filteredFeatureStateEntries.keys()) {
      if (setBuildingFilterFeatureStateById(id, FILTER_CLEAR_STATE)) {
        setCalls += 1;
      }
    }
    filteredFeatureStateEntries = new Map();
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
    if (filteredFeatureStateEntries.size === 0) return;
    let setCalls = 0;
    for (const [id, state] of filteredFeatureStateEntries.entries()) {
      if (setBuildingFilterFeatureStateById(id, state)) {
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
    return filteredFeatureStateEntries.size;
  }

  return {
    applyFeatureStatePlanInChunks,
    applyFilteredFeatureStateEntries,
    applyFilteredFeatureStateMatches,
    clearFilteredFeatureState,
    getFilteredFeatureStateIdsSize,
    reapplyFilteredFeatureState,
    setBuildingFilterFeatureStateById
  };
}
