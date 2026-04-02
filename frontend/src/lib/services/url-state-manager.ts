import { resolve } from '$app/paths';
import { getFilterLayersUrlSignature } from '$lib/client/filterUrlState';
import { parseUrlState, patchUrlState } from '$lib/client/urlState';
import {
  normalizeOptionalMapZoom,
  requestMapFocus,
  setMapBuildings3dEnabled
} from '$lib/stores/map';

function toBuildingUrlParam(selection) {
  const osmType = String(selection?.osmType || '').trim();
  const osmId = Number(selection?.osmId);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) return null;
  return { osmType, osmId };
}

function normalizeOptionalNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function getUrlCameraKey(camera) {
  return [
    camera?.lat ?? '',
    camera?.lng ?? '',
    camera?.z ?? '',
    camera?.pitch ?? '',
    camera?.bearing ?? ''
  ].join(':');
}

function getUrlBuildings3dKey(state) {
  if (state?.buildings3dEnabled == null) return '';
  return state.buildings3dEnabled ? '1' : '0';
}

function getUrlStateSignature(state) {
  return [
    getUrlCameraKey(state.camera),
    getUrlBuildings3dKey(state),
    `${state.building?.osmType ?? ''}/${state.building?.osmId ?? ''}`,
    getFilterLayersUrlSignature(state.filters)
  ].join('|');
}

function getUrlBuildingKey(state) {
  return state.building
    ? `${state.building.osmType}/${state.building.osmId}`
    : '';
}

function getUrlFilterKey(state) {
  return getFilterLayersUrlSignature(state?.filters);
}

function getSelectedBuildingKey(selection) {
  const building = toBuildingUrlParam(selection);
  return building ? `${building.osmType}/${building.osmId}` : '';
}

export function createUrlStateManager({
  onApplyBuilding,
  onClearBuildingSelection,
  onApplyFilters,
  onClearFilters
}: LooseRecord = {}) {
  let urlUpdateInFlight = false;
  let cameraApplyInFlight = false;
  let buildingApplyInFlight = false;
  let buildingCloseInFlight = false;
  let filterApplyInFlight = false;
  let lastAppliedCameraKey = '';
  let handledUrlSignature = '';
  let pendingUrlSignature = '';
  let lastUrlBuildingKey = '';
  let lastUrlFilterKey = '';

  function updateUrlState(patch: LooseRecord, { replaceState: shouldReplaceState = true }: LooseRecord = {}) {
    if (typeof window === 'undefined') return;
    const current = new URL(window.location.href);
    const next = patchUrlState(current, patch);
    if (next.toString() === current.toString()) return;
    const nextState = parseUrlState(next);
    const nextHasCamera = Boolean(nextState.camera);
    urlUpdateInFlight = true;
    try {
      const nextSignature = getUrlStateSignature(nextState);
      if (pendingUrlSignature && nextHasCamera) {
        pendingUrlSignature = nextSignature;
      } else {
        handledUrlSignature = nextSignature;
        pendingUrlSignature = '';
      }
      lastUrlBuildingKey = getUrlBuildingKey(nextState);
      lastUrlFilterKey = getUrlFilterKey(nextState);
      const target = resolve(`${next.pathname}${next.search}${next.hash}`, {});
      if (shouldReplaceState) {
        window.history.replaceState(window.history.state, '', target);
      } else {
        window.history.pushState(window.history.state, '', target);
      }
    } finally {
      queueMicrotask(() => {
        urlUpdateInFlight = false;
      });
    }
  }

  async function applyBuildingFromUrl(building: LooseRecord, { buildingModalOpen, selectedBuilding }: LooseRecord = {}) {
    const osmType = String(building?.osmType || '').trim();
    const osmId = Number(building?.osmId);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) return;
    const buildingKey = `${osmType}/${osmId}`;
    if (buildingApplyInFlight) return;
    if (buildingKey === getSelectedBuildingKey(selectedBuilding) && buildingModalOpen) return;
    buildingApplyInFlight = true;
    try {
      await onApplyBuilding?.({
        osmType,
        osmId,
        lon: null,
        lat: null,
        feature: null
      });
    } finally {
      buildingApplyInFlight = false;
    }
  }

  function applyFiltersFromUrl(
    filters: LooseRecord,
    currentFilters: LooseRecord[] = [],
    { force = false }: LooseRecord = {}
  ) {
    const nextFilterKey = getFilterLayersUrlSignature(filters);
    const currentFilterKey = getFilterLayersUrlSignature(currentFilters);
    if (!force && nextFilterKey === currentFilterKey) return;
    filterApplyInFlight = true;
    try {
      onApplyFilters?.(filters);
    } finally {
      queueMicrotask(() => {
        filterApplyInFlight = false;
      });
    }
  }

  async function applyUrlStateToUi({ mapReady, buildingModalOpen, selectedBuilding, currentFilters }: LooseRecord = {}) {
    if (typeof window === 'undefined') return;
    if (urlUpdateInFlight) return;

    const state = parseUrlState(new URL(window.location.href));
    const signature = getUrlStateSignature(state);
    const hasCamera = Boolean(state.camera);
    const cameraDeferred = Boolean(hasCamera && !mapReady);
    const replayDeferredFilters = Boolean(
      state.filters
      && pendingUrlSignature
      && pendingUrlSignature === signature
      && !cameraDeferred
    );
    if (signature === handledUrlSignature && !cameraDeferred) return;
    if (buildingCloseInFlight) return;
    if (cameraDeferred) {
      pendingUrlSignature = signature;
    }
    if (state.buildings3dEnabled != null) {
      setMapBuildings3dEnabled(state.buildings3dEnabled);
    }
    const nextUrlBuildingKey = getUrlBuildingKey(state);
    const hadUrlBuildingKey = lastUrlBuildingKey;
    lastUrlBuildingKey = nextUrlBuildingKey;
    const nextUrlFilterKey = getUrlFilterKey(state);
    const hadUrlFilterKey = lastUrlFilterKey;
    lastUrlFilterKey = nextUrlFilterKey;

    if (state.camera && mapReady) {
      const cameraKey = getUrlCameraKey(state.camera);
      if (cameraKey !== lastAppliedCameraKey) {
        cameraApplyInFlight = true;
        const allowCameraOrientation = state.buildings3dEnabled !== false;
        requestMapFocus({
          lon: state.camera.lng,
          lat: state.camera.lat,
          zoom: normalizeOptionalMapZoom(state.camera.z) ?? undefined,
          pitch: allowCameraOrientation ? state.camera.pitch ?? undefined : undefined,
          bearing: allowCameraOrientation ? state.camera.bearing ?? undefined : undefined,
          duration: 0
        });
        lastAppliedCameraKey = cameraKey;
        queueMicrotask(() => {
          cameraApplyInFlight = false;
        });
      }
    }

    if (state.filters) {
      // Deep links that carry both camera and filters can resolve the filter store
      // before the map is ready. Re-emit the same filters once the deferred camera
      // has been applied so the map pipeline rebuilds against the final viewport.
      applyFiltersFromUrl(state.filters, currentFilters, { force: replayDeferredFilters });
    } else if (
      hadUrlFilterKey
      && !filterApplyInFlight
      && Array.isArray(currentFilters)
      && currentFilters.length > 0
    ) {
      filterApplyInFlight = true;
      try {
        onClearFilters?.();
      } finally {
        queueMicrotask(() => {
          filterApplyInFlight = false;
        });
      }
    }

    if (state.building) {
      await applyBuildingFromUrl(state.building, {
        buildingModalOpen,
        selectedBuilding
      });
    } else if (hadUrlBuildingKey && (buildingModalOpen || selectedBuilding)) {
      if (!buildingApplyInFlight) {
        onClearBuildingSelection?.();
      }
    }

    if (!cameraDeferred) {
      handledUrlSignature = signature;
      pendingUrlSignature = '';
    }
  }

  function syncBuildingSelection({ mapReady, buildingModalOpen, selectedBuilding }: LooseRecord = {}) {
    if (!mapReady || !buildingModalOpen || !selectedBuilding || buildingApplyInFlight) return;
    const building = toBuildingUrlParam(selectedBuilding);
    updateUrlState(
      { building },
      { replaceState: Boolean(lastUrlBuildingKey) }
    );
  }

  function syncCamera({ mapReady, mapCenter, mapZoom, mapPitch, mapBearing, buildings3dEnabled }: LooseRecord = {}) {
    const normalizedZoom = normalizeOptionalMapZoom(mapZoom);
    if (!mapReady || !mapCenter || normalizedZoom == null || cameraApplyInFlight) return;
    const nextCamera: LooseRecord = {
      lat: mapCenter.lat,
      lng: mapCenter.lng,
      z: normalizedZoom
    };
    if (buildings3dEnabled) {
      const pitch = normalizeOptionalNumber(mapPitch);
      const bearing = normalizeOptionalNumber(mapBearing);
      if (pitch != null) nextCamera.pitch = pitch;
      if (bearing != null) nextCamera.bearing = bearing;
    }
    updateUrlState({
      camera: nextCamera,
      buildings3dEnabled: Boolean(buildings3dEnabled)
    });
  }

  function syncFilters({ currentFilters }: LooseRecord = {}) {
    if (filterApplyInFlight) return;
    updateUrlState({
      filters: currentFilters
    });
  }

  function handleManualBuildingClose({ mapReady }: LooseRecord = {}) {
    buildingCloseInFlight = true;
    if (mapReady) {
      updateUrlState({ building: null });
    }
    queueMicrotask(() => {
      buildingCloseInFlight = false;
    });
  }

  function destroy() {}

  return {
    applyUrlStateToUi,
    destroy,
    handleManualBuildingClose,
    syncBuildingSelection,
    syncCamera,
    syncFilters
  };
}
