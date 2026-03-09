import { pushState, replaceState } from '$app/navigation';
import { resolve } from '$app/paths';
import { get } from 'svelte/store';
import { parseUrlState, patchUrlState } from '$lib/client/urlState';
import { normalizeOptionalMapZoom, requestMapFocus } from '$lib/stores/map';

function toBuildingUrlParam(selection) {
  const osmType = String(selection?.osmType || '').trim();
  const osmId = Number(selection?.osmId);
  if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) return null;
  return { osmType, osmId };
}

function getUrlStateSignature(state) {
  return `${state.camera?.lat ?? ''},${state.camera?.lng ?? ''},${state.camera?.z ?? ''}|${state.building?.osmType ?? ''}/${state.building?.osmId ?? ''}`;
}

function getUrlBuildingKey(state) {
  return state.building
    ? `${state.building.osmType}/${state.building.osmId}`
    : '';
}

function getSelectedBuildingKey(selection) {
  const building = toBuildingUrlParam(selection);
  return building ? `${building.osmType}/${building.osmId}` : '';
}

export function createUrlStateManager({
  pageStore,
  onApplyBuilding,
  onClearBuildingSelection
} = {}) {
  let urlUpdateInFlight = false;
  let cameraApplyInFlight = false;
  let buildingApplyInFlight = false;
  let buildingCloseInFlight = false;
  let lastAppliedCameraKey = '';
  let handledUrlSignature = '';
  let lastUrlBuildingKey = '';

  function updateUrlState(patch, { replaceState: shouldReplaceState = true } = {}) {
    if (typeof window === 'undefined') return;
    const current = new URL(window.location.href);
    const next = patchUrlState(current, patch);
    if (next.toString() === current.toString()) return;
    const nextState = parseUrlState(next);
    urlUpdateInFlight = true;
    try {
      handledUrlSignature = getUrlStateSignature(nextState);
      lastUrlBuildingKey = getUrlBuildingKey(nextState);
      const target = resolve(`${next.pathname}${next.search}${next.hash}`);
      const currentPageState = get(pageStore)?.state ?? {};
      if (shouldReplaceState) {
        replaceState(target, currentPageState);
      } else {
        pushState(target, currentPageState);
      }
    } finally {
      queueMicrotask(() => {
        urlUpdateInFlight = false;
      });
    }
  }

  async function applyBuildingFromUrl(building, { buildingModalOpen, selectedBuilding } = {}) {
    const osmType = String(building?.osmType || '').trim();
    const osmId = Number(building?.osmId);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) return;
    const buildingKey = `${osmType}/${osmId}`;
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

  async function applyUrlStateToUi({ mapReady, buildingModalOpen, selectedBuilding } = {}) {
    if (typeof window === 'undefined') return;
    if (urlUpdateInFlight) return;

    const state = parseUrlState(new URL(window.location.href));
    const signature = getUrlStateSignature(state);
    if (signature === handledUrlSignature) return;
    handledUrlSignature = signature;
    if (buildingCloseInFlight) return;
    const nextUrlBuildingKey = getUrlBuildingKey(state);
    const hadUrlBuildingKey = lastUrlBuildingKey;
    lastUrlBuildingKey = nextUrlBuildingKey;

    if (state.camera && mapReady) {
      const cameraKey = `${state.camera.lat}:${state.camera.lng}:${state.camera.z ?? ''}`;
      if (cameraKey !== lastAppliedCameraKey) {
        cameraApplyInFlight = true;
        requestMapFocus({
          lon: state.camera.lng,
          lat: state.camera.lat,
          zoom: normalizeOptionalMapZoom(state.camera.z) ?? undefined,
          duration: 0
        });
        lastAppliedCameraKey = cameraKey;
        queueMicrotask(() => {
          cameraApplyInFlight = false;
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
  }

  function syncBuildingSelection({ mapReady, buildingModalOpen, selectedBuilding } = {}) {
    if (!mapReady || !buildingModalOpen || !selectedBuilding || buildingApplyInFlight) return;
    const building = toBuildingUrlParam(selectedBuilding);
    updateUrlState(
      { building },
      { replaceState: Boolean(lastUrlBuildingKey) }
    );
  }

  function syncCamera({ mapReady, mapCenter, mapZoom } = {}) {
    const normalizedZoom = normalizeOptionalMapZoom(mapZoom);
    if (!mapReady || !mapCenter || normalizedZoom == null || cameraApplyInFlight) return;
    updateUrlState({
      camera: {
        lat: mapCenter.lat,
        lng: mapCenter.lng,
        z: normalizedZoom
      }
    });
  }

  function handleManualBuildingClose({ mapReady } = {}) {
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
    syncCamera
  };
}
