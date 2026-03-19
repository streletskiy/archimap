import { get, writable } from 'svelte/store';
import { translateNow } from '$lib/i18n/index';
import { getRuntimeConfig } from '$lib/services/config';
import { apiJson } from '$lib/services/http';
import { session } from '$lib/stores/auth';
import { selectedBuilding, setSelectedBuilding } from '$lib/stores/map';
import { closeBuildingModal, openBuildingModal } from '$lib/stores/ui';
import { normalizeArchitectureStyleKey } from '$lib/utils/architecture-style';
import { normalizeBuildingMaterialKey } from '$lib/utils/building-material';
import { resolveAddressText } from '$lib/utils/building-address';
import { isAbortError } from '$lib/utils/error';
import {
  coerceNullableIntegerText,
  coerceNullableText,
  normalizeEditedBuildingFields,
  pickNullableText
} from '$lib/utils/text';

const initialState = {
  buildingDetails: null,
  savePending: false,
  saveStatus: '',
  selectedBuildingIdentity: null
};

function isSelectionDebugEnabled() {
  const cfg = getRuntimeConfig();
  const isLocalRuntime = typeof window !== 'undefined'
    && ['localhost', '127.0.0.1'].includes(window.location.hostname);
  return Boolean(cfg?.mapSelection?.debug || import.meta.env.DEV || isLocalRuntime);
}

function debugSelectionLog(eventName, payload = {}) {
  if (!isSelectionDebugEnabled()) return;
  console.debug('[map-selection]', eventName, {
    ts: new Date().toISOString(),
    ...payload
  });
}

function updateSelectionDebugHook(selection) {
  if (!isSelectionDebugEnabled() || typeof document === 'undefined') return;
  const key = selection?.osmType && selection?.osmId
    ? `${selection.osmType}/${selection.osmId}`
    : '';
  document.body.dataset.selectedBuildingId = key;
  window.__APP_STATE__ = window.__APP_STATE__ || {};
  window.__APP_STATE__.selectedBuildingId = key || null;
}

function normalizeArchiInfo(payload) {
  const info = payload || {};
  const sourceTags = info._sourceTags && typeof info._sourceTags === 'object' ? info._sourceTags : {};
  const styleRaw = pickNullableText(
    info.style,
    info.architecture,
    info['building:style'],
    info['building:architecture']
  );
  return {
    name: pickNullableText(info.name, info['name:ru'], info['name:en']),
    style: styleRaw,
    styleRaw,
    levels: coerceNullableIntegerText(info.levels ?? info['building:levels'], 0, 300),
    year_built: coerceNullableIntegerText(
      info.year_built ?? info['building:year'] ?? info.start_date,
      1000,
      2100
    ),
    architect: pickNullableText(info.architect, info['building:architect']),
    material: pickNullableText(info.material, info['building:material'], sourceTags?.['building:material'], sourceTags?.material),
    colour: pickNullableText(info.colour, info['building:colour'], sourceTags?.['building:colour'], sourceTags?.colour),
    address: resolveAddressText(info, pickNullableText, info.address),
    description: pickNullableText(info.description),
    archimap_description: pickNullableText(info.archimap_description, info.description),
    _sourceTags: info._sourceTags && typeof info._sourceTags === 'object' ? info._sourceTags : {}
  };
}

function createFallbackBuildingDetails() {
  return {
    feature_kind: null,
    region_slugs: [],
    properties: {
      archiInfo: {
        name: null,
        style: null,
        styleRaw: null,
        levels: null,
        year_built: null,
        architect: null,
        material: null,
        colour: null,
        address: null,
        _sourceTags: {}
      }
    }
  };
}

function normalizeBuildingSelection(detail) {
  const osmType = String(detail?.osmType || '').trim();
  const osmId = Number(detail?.osmId);
  if (!osmType || !Number.isInteger(osmId) || osmId <= 0) return null;
  return {
    osmType,
    osmId,
    lon: Number.isFinite(Number(detail?.lon)) ? Number(detail.lon) : null,
    lat: Number.isFinite(Number(detail?.lat)) ? Number(detail.lat) : null,
    feature: detail?.feature || null
  };
}

function toDisplayArchiInfoFromPayload(currentInfo, payload, editedFields = []) {
  const next = currentInfo && typeof currentInfo === 'object'
    ? { ...currentInfo }
    : { _sourceTags: {} };
  const rawStyle = coerceNullableText(payload?.style);
  const editedFieldSet = new Set(normalizeEditedBuildingFields(editedFields));
  const applyAll = editedFieldSet.size === 0;

  if (applyAll || editedFieldSet.has('name')) next.name = coerceNullableText(payload?.name);
  if (applyAll || editedFieldSet.has('style')) {
    next.styleRaw = rawStyle;
    next.style = rawStyle;
  }
  if (applyAll || editedFieldSet.has('material')) next.material = coerceNullableText(payload?.material);
  if (applyAll || editedFieldSet.has('colour')) next.colour = coerceNullableText(payload?.colour);
  if (applyAll || editedFieldSet.has('levels')) next.levels = coerceNullableIntegerText(payload?.levels, 0, 300);
  if (applyAll || editedFieldSet.has('yearBuilt')) next.year_built = coerceNullableIntegerText(payload?.yearBuilt, 1000, 2100);
  if (applyAll || editedFieldSet.has('architect')) next.architect = coerceNullableText(payload?.architect);
  if (applyAll || editedFieldSet.has('address')) next.address = coerceNullableText(payload?.address);
  if (applyAll || editedFieldSet.has('archimapDescription')) {
    next.archimap_description = coerceNullableText(payload?.archimapDescription);
    next.description = coerceNullableText(payload?.archimapDescription);
  }

  next._sourceTags = currentInfo?._sourceTags || {};
  return next;
}

export function createBuildingDetailsManager() {
  const state = writable(initialState);
  let activeBuildingDetailsAbortController = null;
  let activeBuildingDetailsToken = 0;
  const stopSelectionDebugSync = selectedBuilding.subscribe((selection) => {
    updateSelectionDebugHook(selection);
  });

  function updateState(patch) {
    state.update((current) => ({
      ...current,
      ...patch
    }));
  }

  async function loadBuildingDetails(detail) {
    const token = ++activeBuildingDetailsToken;
    if (activeBuildingDetailsAbortController) {
      activeBuildingDetailsAbortController.abort();
    }
    activeBuildingDetailsAbortController = new AbortController();
    const signal = activeBuildingDetailsAbortController.signal;
    debugSelectionLog('details-load-start', {
      selectionKey: `${detail.osmType}/${detail.osmId}`
    });

    let feature = null;
    try {
      const data = await apiJson(`/api/building-info/${detail.osmType}/${detail.osmId}`, { signal });
      let sourceTags = {};
      try {
        feature = await apiJson(`/api/building/${detail.osmType}/${detail.osmId}`, { signal });
        sourceTags = feature?.properties?.source_tags || {};
      } catch (featureError) {
        if (!isAbortError(featureError)) {
          sourceTags = detail?.feature?.properties?.source_tags || {};
        } else {
          throw featureError;
        }
      }
      if (token !== activeBuildingDetailsToken) return;
      updateState({
        buildingDetails: {
          feature_kind: data?.feature_kind || feature?.properties?.feature_kind || detail?.feature?.properties?.feature_kind || null,
          region_slugs: Array.isArray(data?.region_slugs) ? data.region_slugs : [],
          properties: {
            archiInfo: normalizeArchiInfo({
              ...data,
              _sourceTags: sourceTags
            })
          }
        }
      });
      debugSelectionLog('details-load-success', {
        selectionKey: `${detail.osmType}/${detail.osmId}`
      });
      return;
    } catch (primaryError) {
      if (isAbortError(primaryError)) return;
      try {
        const feature = await apiJson(`/api/building/${detail.osmType}/${detail.osmId}`, { signal });
        const archiInfo = feature?.properties?.archiInfo || feature?.properties?.source_tags || feature?.properties || {};
        if (token !== activeBuildingDetailsToken) return;
        updateState({
          buildingDetails: {
            feature_kind: feature?.properties?.feature_kind || detail?.feature?.properties?.feature_kind || null,
            region_slugs: [],
            properties: {
              archiInfo: normalizeArchiInfo({
                ...archiInfo,
                _sourceTags: feature?.properties?.source_tags || {}
              })
            }
          }
        });
      } catch (fallbackError) {
        if (isAbortError(fallbackError)) return;
        if (token !== activeBuildingDetailsToken) return;
        updateState({
          buildingDetails: createFallbackBuildingDetails()
        });
      }
    } finally {
      if (activeBuildingDetailsAbortController?.signal === signal) {
        activeBuildingDetailsAbortController = null;
      }
    }
  }

  function selectBuilding(detail) {
    const normalized = normalizeBuildingSelection(detail);
    if (!normalized) return;
    setSelectedBuilding({
      osmType: normalized.osmType,
      osmId: normalized.osmId,
      lon: normalized.lon,
      lat: normalized.lat
    });
    updateState({
      buildingDetails: null,
      saveStatus: '',
      selectedBuildingIdentity: {
        osmType: normalized.osmType,
        osmId: normalized.osmId
      }
    });
    debugSelectionLog('panel-open', {
      selectionKey: `${normalized.osmType}/${normalized.osmId}`
    });
    openBuildingModal();
    void loadBuildingDetails(normalized);
  }

  function clearSelection() {
    if (activeBuildingDetailsAbortController) {
      activeBuildingDetailsAbortController.abort();
      activeBuildingDetailsAbortController = null;
    }
    updateState({
      buildingDetails: null
    });
    setSelectedBuilding(null);
    closeBuildingModal();
  }

  async function saveEdit(detail) {
    const normalized = normalizeBuildingSelection(detail);
    if (!normalized) return;
    const currentState = get(state);
    const isBuildingPartFeature = currentState.buildingDetails?.feature_kind === 'building_part';
    const allowedPartFields = new Set(['levels', 'colour', 'style', 'material', 'yearBuilt']);

    if (!get(session).authenticated) {
      updateState({ saveStatus: translateNow('mapPage.authRequired') });
      return;
    }

    const editedFields = normalizeEditedBuildingFields(detail.editedFields);
    const outgoingEditedFields = isBuildingPartFeature
      ? editedFields.filter((field) => allowedPartFields.has(field))
      : editedFields;
    if (outgoingEditedFields.length === 0) {
      updateState({ saveStatus: translateNow('buildingModal.noChanges') });
      return;
    }

    updateState({
      savePending: true,
      saveStatus: translateNow('mapPage.saving')
    });

    const payload = {
      osmType: normalized.osmType,
      osmId: normalized.osmId,
      name: isBuildingPartFeature ? null : coerceNullableText(detail.name),
      style: coerceNullableText(normalizeArchitectureStyleKey(detail.style)),
      material: coerceNullableText(normalizeBuildingMaterialKey(detail.material)),
      colour: coerceNullableText(detail.colour),
      levels: coerceNullableIntegerText(detail.levels, 0, 300),
      yearBuilt: coerceNullableIntegerText(detail.yearBuilt, 1000, 2100),
      architect: isBuildingPartFeature ? null : coerceNullableText(detail.architect),
      address: isBuildingPartFeature ? null : coerceNullableText(detail.address),
      archimapDescription: isBuildingPartFeature ? null : coerceNullableText(detail.archimapDescription),
      editedFields: outgoingEditedFields
    };

    try {
      await apiJson('/api/building-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      state.update((current) => {
        const isSameSelection = current.selectedBuildingIdentity
          && current.selectedBuildingIdentity.osmType === payload.osmType
          && current.selectedBuildingIdentity.osmId === payload.osmId;

        return {
          ...current,
          buildingDetails: isSameSelection
            ? {
                ...current.buildingDetails,
                feature_kind: current.buildingDetails?.feature_kind || null,
                region_slugs: Array.isArray(current.buildingDetails?.region_slugs)
                  ? current.buildingDetails.region_slugs
                  : [],
                properties: {
                  archiInfo: toDisplayArchiInfoFromPayload(
                    current.buildingDetails?.properties?.archiInfo,
                    payload,
                    outgoingEditedFields
                  )
                }
              }
            : current.buildingDetails,
          saveStatus: translateNow('mapPage.submitted')
        };
      });
    } catch (error) {
      updateState({
        saveStatus: String(error?.message || translateNow('mapPage.saveFailed'))
      });
    } finally {
      updateState({
        savePending: false
      });
    }
  }

  function destroy() {
    if (activeBuildingDetailsAbortController) {
      activeBuildingDetailsAbortController.abort();
      activeBuildingDetailsAbortController = null;
    }
    stopSelectionDebugSync();
  }

  return {
    subscribe: state.subscribe,
    clearSelection,
    destroy,
    saveEdit,
    selectBuilding
  };
}
