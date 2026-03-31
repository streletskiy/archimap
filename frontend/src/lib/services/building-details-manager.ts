import { get, writable } from 'svelte/store';
import { translateNow } from '$lib/i18n/index';
import { getRuntimeConfig } from '$lib/services/config';
import { apiJson } from '$lib/services/http';
import { session } from '$lib/stores/auth';
import {
  clearSelectedBuildings,
  selectedBuilding,
  selectedBuildings,
  setSelectedBuilding,
  setSelectedBuildings
} from '$lib/stores/map';
import { closeBuildingModal, openBuildingModal } from '$lib/stores/ui';
import { normalizeArchitectureStyleKey } from '$lib/utils/architecture-style';
import {
  normalizeBuildingMaterialSelection,
  splitBuildingMaterialSelection
} from '$lib/utils/building-material';
import { filterBuildingEditedFields } from '$lib/utils/building-edit-fields';
import { resolveAddressText } from '$lib/utils/building-address';
import { isAbortError } from '$lib/utils/error';
import {
  coerceNullableIntegerText,
  coerceNullableText,
  normalizeEditedBuildingFields,
  pickNullableText
} from '$lib/utils/text';
import { getEditedBuildingFields, hydrateBuildingForm } from '$lib/utils/building-mapper';
import { getOverpassBuildingDetails } from '$lib/services/map/overpass-buildings';

const initialState = {
  buildingDetails: null,
  selectedBuildingDetails: [],
  selectedBuildingDetailKeys: [],
  savePending: false,
  saveStatus: '',
  selectedBuildingIdentity: null
};

function isSelectionDebugEnabled() {
  const cfg = getRuntimeConfig();
  const isLocalRuntime = typeof window !== 'undefined'
    && ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const meta = import.meta as LooseRecord;
  return Boolean(cfg?.mapSelection?.debug || meta?.env?.DEV || isLocalRuntime);
}

function debugSelectionLog(eventName, payload: LooseRecord = {}) {
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

function normalizeArchiInfo(payload: LooseRecord) {
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
    design: pickNullableText(info.design, sourceTags?.design),
    design_ref: pickNullableText(info.design_ref, info['design:ref'], sourceTags?.['design:ref'], sourceTags?.design_ref),
    design_year: coerceNullableIntegerText(
      info.design_year ?? info['design:year'] ?? sourceTags?.['design:year'] ?? sourceTags?.design_year,
      1000,
      2100
    ),
    levels: coerceNullableIntegerText(info.levels ?? info['building:levels'], 0, 300),
    year_built: coerceNullableIntegerText(
      info.year_built ?? info['building:year'] ?? info.start_date,
      1000,
      2100
    ),
    architect: pickNullableText(info.architect, info['building:architect']),
    material: normalizeBuildingMaterialSelection(
      pickNullableText(info.material, info['building:material'], sourceTags?.['building:material'], sourceTags?.material),
      pickNullableText(
        info.material_concrete,
        info['building:material:concrete'],
        sourceTags?.['building:material:concrete'],
        sourceTags?.material_concrete
      )
    ),
    materialRaw: pickNullableText(info.material, info['building:material'], sourceTags?.['building:material'], sourceTags?.material),
    materialConcrete: pickNullableText(
      info.material_concrete,
      info['building:material:concrete'],
      sourceTags?.['building:material:concrete'],
      sourceTags?.material_concrete
    ),
    colour: pickNullableText(info.colour, info['building:colour'], sourceTags?.['building:colour'], sourceTags?.colour),
    address: resolveAddressText(info, pickNullableText, info.address),
    description: pickNullableText(info.description),
    archimap_description: pickNullableText(info.archimap_description, info.description),
    design_ref_suggestions: Array.isArray(info.design_ref_suggestions)
      ? info.design_ref_suggestions
        .map((value) => pickNullableText(value))
        .filter(Boolean)
      : [],
    _sourceTags: info._sourceTags && typeof info._sourceTags === 'object' ? info._sourceTags : {}
  };
}

function normalizeJsonString(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed == null) return null;
      return JSON.stringify(parsed);
    } catch {
      return null;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function buildSourceSnapshotFromFeature(feature) {
  if (!feature || typeof feature !== 'object') {
    return {
      sourceGeometryJson: null,
      sourceTagsJson: null,
      sourceOsmUpdatedAt: null,
      featureKind: null
    };
  }
  const properties = feature?.properties && typeof feature.properties === 'object'
    ? feature.properties
    : {};
  const sourceTags = properties?.source_tags && typeof properties.source_tags === 'object'
    ? properties.source_tags
    : {};
  return {
    sourceGeometryJson: feature?.geometry == null ? null : normalizeJsonString(feature.geometry),
    sourceTagsJson: normalizeJsonString(sourceTags),
    sourceOsmUpdatedAt: pickNullableText(properties?.source_osm_updated_at),
    featureKind: pickNullableText(properties?.feature_kind)
  };
}

function buildSourceSnapshotFromDetail(detail) {
  const explicit = {
    sourceGeometryJson: normalizeJsonString(detail?.sourceGeometryJson ?? detail?.source_geometry_json ?? null),
    sourceTagsJson: normalizeJsonString(detail?.sourceTagsJson ?? detail?.source_tags_json ?? null),
    sourceOsmUpdatedAt: pickNullableText(detail?.sourceOsmUpdatedAt ?? detail?.source_osm_updated_at ?? null),
    featureKind: pickNullableText(detail?.featureKind ?? detail?.feature_kind ?? detail?.feature?.properties?.feature_kind ?? null)
  };
  const fallback = detail?.feature ? buildSourceSnapshotFromFeature(detail.feature) : {
    sourceGeometryJson: null,
    sourceTagsJson: null,
    sourceOsmUpdatedAt: null,
    featureKind: null
  };
  return {
    sourceGeometryJson: explicit.sourceGeometryJson || fallback.sourceGeometryJson,
    sourceTagsJson: explicit.sourceTagsJson || fallback.sourceTagsJson,
    sourceOsmUpdatedAt: explicit.sourceOsmUpdatedAt || fallback.sourceOsmUpdatedAt,
    featureKind: explicit.featureKind || fallback.featureKind
  };
}

function createFallbackBuildingDetails(detail = null) {
  const sourceSnapshot = buildSourceSnapshotFromDetail(detail);
  return {
    feature_kind: detail?.featureKind || detail?.feature?.properties?.feature_kind || null,
    sourceGeometryJson: sourceSnapshot.sourceGeometryJson,
    sourceTagsJson: sourceSnapshot.sourceTagsJson,
    sourceOsmUpdatedAt: sourceSnapshot.sourceOsmUpdatedAt,
    review_status: null,
    admin_comment: null,
    user_edit_id: null,
    updated_by: null,
    updated_at: null,
    region_slugs: [],
    properties: {
      archiInfo: {
        name: null,
        style: null,
        styleRaw: null,
        design: null,
        design_ref: null,
        design_year: null,
        levels: null,
        year_built: null,
        architect: null,
        material: null,
        materialRaw: null,
        materialConcrete: null,
        colour: null,
        address: null,
        design_ref_suggestions: [],
        _sourceTags: {}
      }
    },
    design_ref_suggestions: []
  };
}

function normalizeBuildingSelection(detail) {
  const osmType = String(detail?.osmType || '').trim();
  const osmId = Number(detail?.osmId);
  if (!osmType || !Number.isInteger(osmId) || osmId <= 0) return null;
  const lonRaw = detail?.lon;
  const latRaw = detail?.lat;
  const lon = lonRaw == null || lonRaw === '' ? null : Number(lonRaw);
  const lat = latRaw == null || latRaw === '' ? null : Number(latRaw);
  return {
    osmType,
    osmId,
    lon: lon != null && Number.isFinite(lon) ? lon : null,
    lat: lat != null && Number.isFinite(lat) ? lat : null,
    featureKind: String(detail?.featureKind || detail?.feature_kind || detail?.feature?.properties?.feature_kind || '').trim() || null
  };
}

function getSelectionKey(selection) {
  const osmType = String(selection?.osmType || '').trim();
  const osmId = Number(selection?.osmId);
  if (!osmType || !Number.isInteger(osmId) || osmId <= 0) return '';
  return `${osmType}/${osmId}`;
}

function toDisplayArchiInfoFromPayload(currentInfo, payload: LooseRecord, editedFields: LooseRecord[] = []) {
  const next = currentInfo && typeof currentInfo === 'object'
    ? { ...currentInfo }
    : { _sourceTags: {} };
  const rawStyle = coerceNullableText(payload?.style);
  const rawDesign = coerceNullableText(payload?.design);
  const rawDesignRef = coerceNullableText(payload?.designRef);
  const rawDesignYear = coerceNullableIntegerText(payload?.designYear, 1000, 2100);
  const materialSelection = normalizeBuildingMaterialSelection(payload?.material);
  const splitMaterial = splitBuildingMaterialSelection(materialSelection);
  const editedFieldSet = new Set(normalizeEditedBuildingFields(editedFields));
  const applyAll = editedFieldSet.size === 0;

  if (applyAll || editedFieldSet.has('name')) next.name = coerceNullableText(payload?.name);
  if (applyAll || editedFieldSet.has('style')) {
    next.styleRaw = rawStyle;
    next.style = rawStyle;
  }
  if (applyAll || editedFieldSet.has('design')) {
    next.design = rawDesign;
  }
  if (applyAll || editedFieldSet.has('designRef')) next.design_ref = rawDesignRef;
  if (applyAll || editedFieldSet.has('designYear')) next.design_year = rawDesignYear;
  if (applyAll || editedFieldSet.has('material')) {
    next.material = coerceNullableText(splitMaterial.material);
    next.material_concrete = coerceNullableText(splitMaterial.materialConcrete);
  }
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

function getComparableFromSelectedBuildingDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  try {
    const hydrated = hydrateBuildingForm(detail);
    return hydrated?.initialComparable && typeof hydrated.initialComparable === 'object'
      ? hydrated.initialComparable
      : null;
  } catch {
    return null;
  }
}

function getBulkSaveTargets(options: {
  selectionItems?: LooseRecord[];
  currentState?: LooseRecord;
  snapshot?: LooseRecord | null;
  outgoingEditedFields?: string[];
} = {}) {
  const {
    selectionItems = [],
    currentState = {},
    snapshot = null,
    outgoingEditedFields = []
  } = /** @type {LooseRecord} */ (options);
  const items = Array.isArray(selectionItems) ? selectionItems : [];
  if (items.length === 0) return [];
  const isBulkSelection = items.length > 1;

  const selectionKeys = items.map((item) => getSelectionKey(item));
  const currentSelectionDetails = Array.isArray(currentState.selectedBuildingDetails)
    ? currentState.selectedBuildingDetails
    : [];
  const currentSelectionKeys = Array.isArray(currentState.selectedBuildingDetailKeys)
    ? currentState.selectedBuildingDetailKeys
    : [];
  const canCompareSelectionDetails = currentSelectionDetails.length === items.length
    && currentSelectionKeys.length === selectionKeys.length
    && currentSelectionKeys.every((key, index) => key === selectionKeys[index]);
  const selectionDetailsByKey = canCompareSelectionDetails
    ? new Map(selectionKeys.map((key, index) => [key, currentSelectionDetails[index]]))
    : null;

  return items.map((item, index) => {
    const itemKey = selectionKeys[index];
    const itemDetail = selectionDetailsByKey?.get(itemKey)
      || (!isBulkSelection ? (currentState.buildingDetails || currentSelectionDetails[0] || null) : null);
    const itemComparable = getComparableFromSelectedBuildingDetail(itemDetail);
    const itemChangedFields = itemComparable ? getEditedBuildingFields(snapshot, itemComparable) : outgoingEditedFields;
    const itemEditedFields = itemChangedFields.filter((field) => outgoingEditedFields.includes(field));
    return itemEditedFields.length > 0
      ? {
          item,
          editedFields: itemEditedFields,
          sourceSnapshot: buildSourceSnapshotFromDetail(itemDetail)
        }
      : null;
  }).filter(Boolean);
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

  async function fetchBuildingDetails(detail, signal) {
    let feature = null;
    const localOverpassDetail = detail?.feature?.properties?.source === 'overpass'
      ? getOverpassBuildingDetails(detail.feature)
      : getOverpassBuildingDetails(`${detail?.osmType || ''}/${detail?.osmId || ''}`);
    if (localOverpassDetail) {
      return localOverpassDetail;
    }
    try {
      const data = await apiJson(`/api/building-info/${detail.osmType}/${detail.osmId}`, { signal });
      const reviewStatus = String(data?.review_status || '').trim().toLowerCase() || null;
      const userEditId = Number(data?.user_edit_id || 0);
      const { sourceTags, sourceSnapshot } = await (async () => {
        try {
          feature = await apiJson(`/api/building/${detail.osmType}/${detail.osmId}`, { signal });
          return {
            sourceTags: feature?.properties?.source_tags || {},
            sourceSnapshot: buildSourceSnapshotFromFeature(feature)
          };
        } catch (featureError) {
          if (isAbortError(featureError)) {
            throw featureError;
          }
          return {
            sourceTags: detail?.feature?.properties?.source_tags || {},
            sourceSnapshot: buildSourceSnapshotFromDetail(detail)
          };
        }
      })();
      return {
        feature_kind: data?.feature_kind || feature?.properties?.feature_kind || detail?.featureKind || detail?.feature?.properties?.feature_kind || null,
        sourceGeometryJson: sourceSnapshot.sourceGeometryJson,
        sourceTagsJson: sourceSnapshot.sourceTagsJson,
        sourceOsmUpdatedAt: sourceSnapshot.sourceOsmUpdatedAt,
        review_status: reviewStatus,
        admin_comment: coerceNullableText(data?.admin_comment),
        user_edit_id: Number.isInteger(userEditId) && userEditId > 0 ? userEditId : null,
        updated_by: coerceNullableText(data?.updated_by),
        updated_at: coerceNullableText(data?.updated_at),
        region_slugs: Array.isArray(data?.region_slugs) ? data.region_slugs : [],
        design_ref_suggestions: Array.isArray(data?.design_ref_suggestions) ? data.design_ref_suggestions : [],
        properties: {
          archiInfo: normalizeArchiInfo({
            ...data,
            _sourceTags: sourceTags
          })
        }
      };
    } catch (primaryError) {
      if (isAbortError(primaryError)) throw primaryError;
      try {
        feature = await apiJson(`/api/building/${detail.osmType}/${detail.osmId}`, { signal });
        const archiInfo = feature?.properties?.archiInfo || feature?.properties?.source_tags || feature?.properties || {};
        const sourceSnapshot = buildSourceSnapshotFromFeature(feature);
        return {
          feature_kind: feature?.properties?.feature_kind || detail?.featureKind || detail?.feature?.properties?.feature_kind || null,
          sourceGeometryJson: sourceSnapshot.sourceGeometryJson,
          sourceTagsJson: sourceSnapshot.sourceTagsJson,
          sourceOsmUpdatedAt: sourceSnapshot.sourceOsmUpdatedAt,
          review_status: null,
          admin_comment: null,
          user_edit_id: null,
          updated_by: null,
          updated_at: null,
          region_slugs: [],
          design_ref_suggestions: [],
          properties: {
            archiInfo: normalizeArchiInfo({
              ...archiInfo,
              _sourceTags: feature?.properties?.source_tags || {}
            })
          }
        };
      } catch (fallbackError) {
        if (isAbortError(fallbackError)) throw fallbackError;
        return createFallbackBuildingDetails(detail);
      }
    }
  }

  async function loadSelectionDetails(selectionItems = []) {
    const normalizedSelections = (Array.isArray(selectionItems) ? selectionItems : [])
      .map((item) => normalizeBuildingSelection(item))
      .filter(Boolean);
    if (normalizedSelections.length === 0) return;

    const token = ++activeBuildingDetailsToken;
    if (activeBuildingDetailsAbortController) {
      activeBuildingDetailsAbortController.abort();
    }
    activeBuildingDetailsAbortController = new AbortController();
    const signal = activeBuildingDetailsAbortController.signal;
    const selectionKeys = normalizedSelections.map((item) => getSelectionKey(item));

    debugSelectionLog('details-load-start', {
      selectionKey: selectionKeys[0] || '',
      selectionCount: normalizedSelections.length
    });

    try {
      const detailItems = await Promise.all(
        normalizedSelections.map((item) => fetchBuildingDetails(item, signal))
      );
      if (token !== activeBuildingDetailsToken) return;
      updateState({
        buildingDetails: detailItems[0] || null,
        selectedBuildingDetails: detailItems,
        selectedBuildingDetailKeys: selectionKeys,
        selectedBuildingIdentity: normalizedSelections[0]
          ? {
              osmType: normalizedSelections[0].osmType,
              osmId: normalizedSelections[0].osmId
            }
          : null
      });
      debugSelectionLog('details-load-success', {
        selectionKey: selectionKeys[0] || '',
        selectionCount: detailItems.length
      });
    } catch (error) {
      if (isAbortError(error)) return;
      if (token !== activeBuildingDetailsToken) return;
      const fallbackDetails = normalizedSelections.map((item) => createFallbackBuildingDetails(item));
      updateState({
        buildingDetails: fallbackDetails[0] || null,
        selectedBuildingDetails: fallbackDetails,
        selectedBuildingDetailKeys: selectionKeys,
        selectedBuildingIdentity: normalizedSelections[0]
          ? {
              osmType: normalizedSelections[0].osmType,
              osmId: normalizedSelections[0].osmId
            }
          : null
      });
    } finally {
      if (activeBuildingDetailsAbortController?.signal === signal) {
        activeBuildingDetailsAbortController = null;
      }
    }
  }

  function selectBuilding(detail) {
    const normalized = normalizeBuildingSelection(detail);
    if (!normalized) return;
    const shiftKey = Boolean(detail?.shiftKey);
    const currentSelections = Array.isArray(get(selectedBuildings)) ? get(selectedBuildings) : [];
    const currentPrimary = currentSelections[0] || null;
    const currentPrimaryKey = getSelectionKey(currentPrimary);
    const normalizedKey = getSelectionKey(normalized);

    if (shiftKey) {
      const existingIndex = currentSelections.findIndex((item) => getSelectionKey(item) === normalizedKey);
      const nextSelections = existingIndex >= 0
        ? currentSelections.filter((_, index) => index !== existingIndex)
        : [...currentSelections, normalized];

      if (nextSelections.length === 0) {
        clearSelection();
        return;
      }

      setSelectedBuildings(nextSelections);
      const nextPrimary = nextSelections[0] || null;
      const nextPrimaryKey = getSelectionKey(nextPrimary);
      openBuildingModal();
      updateState({
        buildingDetails: nextPrimaryKey !== currentPrimaryKey ? null : get(state).buildingDetails,
        selectedBuildingDetails: [],
        selectedBuildingDetailKeys: [],
        saveStatus: '',
        selectedBuildingIdentity: {
          osmType: nextPrimary.osmType,
          osmId: nextPrimary.osmId
        }
      });
      void loadSelectionDetails(nextSelections);
      debugSelectionLog('panel-open', {
        selectionKey: nextPrimaryKey || normalizedKey,
        selectionCount: nextSelections.length,
        shiftKey: true
      });
      return;
    }

    setSelectedBuilding({
      osmType: normalized.osmType,
      osmId: normalized.osmId,
      lon: normalized.lon,
      lat: normalized.lat,
      featureKind: normalized.featureKind
    });
    updateState({
      buildingDetails: null,
      selectedBuildingDetails: [],
      selectedBuildingDetailKeys: [],
      saveStatus: '',
      selectedBuildingIdentity: {
        osmType: normalized.osmType,
        osmId: normalized.osmId
      }
    });
    debugSelectionLog('panel-open', {
      selectionKey: normalizedKey,
      selectionCount: 1,
      shiftKey: false
    });
    openBuildingModal();
    void loadSelectionDetails([normalized]);
  }

  function clearSelection() {
    if (activeBuildingDetailsAbortController) {
      activeBuildingDetailsAbortController.abort();
      activeBuildingDetailsAbortController = null;
    }
    updateState({
      buildingDetails: null,
      selectedBuildingDetails: [],
      selectedBuildingDetailKeys: [],
      saveStatus: '',
      selectedBuildingIdentity: null
    });
    clearSelectedBuildings();
    closeBuildingModal();
  }

  async function saveEdit(detail) {
    const normalized = normalizeBuildingSelection(detail);
    if (!normalized) return;
    const currentState = get(state);
    const activeSelections = Array.isArray(get(selectedBuildings)) ? get(selectedBuildings) : [];
    const selectionItems = activeSelections.length > 0 ? activeSelections : [normalized];
    const isBulkSelection = selectionItems.length > 1;
    const hasBuildingPartSelection = currentState.buildingDetails?.feature_kind === 'building_part'
      || selectionItems.some((item) => item?.featureKind === 'building_part');

    if (!get(session).authenticated) {
      updateState({ saveStatus: translateNow('mapPage.authRequired') });
      return;
    }

    const outgoingEditedFields = filterBuildingEditedFields(detail.editedFields, {
      isBulkSelection,
      hasBuildingPartSelection
    });
    if (outgoingEditedFields.length === 0) {
      updateState({ saveStatus: translateNow('buildingModal.noChanges') });
      return;
    }

    const saveTargets = getBulkSaveTargets({
      selectionItems,
      currentState,
      snapshot: detail,
      outgoingEditedFields
    });
    if (saveTargets.length === 0) {
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
      name: hasBuildingPartSelection ? null : coerceNullableText(detail.name),
      style: coerceNullableText(normalizeArchitectureStyleKey(detail.style)),
      design: hasBuildingPartSelection ? null : coerceNullableText(detail.design),
      designRef: hasBuildingPartSelection ? null : coerceNullableText(detail.designRef),
      designYear: hasBuildingPartSelection ? null : coerceNullableIntegerText(detail.designYear, 1000, 2100),
      material: coerceNullableText(normalizeBuildingMaterialSelection(detail.material)),
      colour: coerceNullableText(detail.colour),
      levels: coerceNullableIntegerText(detail.levels, 0, 300),
      yearBuilt: coerceNullableIntegerText(detail.yearBuilt, 1000, 2100),
      architect: hasBuildingPartSelection ? null : coerceNullableText(detail.architect),
      address: isBulkSelection || hasBuildingPartSelection ? null : coerceNullableText(detail.address),
      archimapDescription: hasBuildingPartSelection ? null : coerceNullableText(detail.archimapDescription),
      editedFields: outgoingEditedFields
    };

    try {
      let lastSaveResult = null;
      for (const target of saveTargets) {
        const sourceSnapshot = (target?.sourceSnapshot || {}) as any;
        lastSaveResult = await apiJson('/api/building-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            osmType: target.item.osmType,
            osmId: target.item.osmId,
            editedFields: target.editedFields,
            sourceGeometryJson: sourceSnapshot.sourceGeometryJson ?? currentState.buildingDetails?.sourceGeometryJson ?? null,
            sourceTagsJson: sourceSnapshot.sourceTagsJson ?? currentState.buildingDetails?.sourceTagsJson ?? null,
            sourceOsmUpdatedAt: sourceSnapshot.sourceOsmUpdatedAt ?? currentState.buildingDetails?.sourceOsmUpdatedAt ?? null,
            featureKind: sourceSnapshot.featureKind ?? currentState.buildingDetails?.feature_kind ?? normalized.featureKind ?? null
          })
        });
      }
      const savedEditId = Number(lastSaveResult?.editId || 0);
      const savedReviewStatus = String(lastSaveResult?.status || '').trim().toLowerCase() || 'pending';

      state.update((current) => {
        const isSameSelection = current.selectedBuildingIdentity
          && current.selectedBuildingIdentity.osmType === payload.osmType
          && current.selectedBuildingIdentity.osmId === payload.osmId;
        const selectionKeys = selectionItems.map((item) => getSelectionKey(item));
        const canPatchSelectedDetails = isSameSelection
          && Array.isArray(current.selectedBuildingDetails)
          && current.selectedBuildingDetails.length === selectionItems.length
          && Array.isArray(current.selectedBuildingDetailKeys)
          && current.selectedBuildingDetailKeys.length === selectionKeys.length
          && current.selectedBuildingDetailKeys.every((key, index) => key === selectionKeys[index]);
        const nextSelectedBuildingDetails = canPatchSelectedDetails
          ? current.selectedBuildingDetails.map((detail) => ({
              ...detail,
              review_status: savedReviewStatus,
              user_edit_id: Number.isInteger(savedEditId) && savedEditId > 0 ? savedEditId : detail?.user_edit_id ?? null,
              properties: {
                archiInfo: toDisplayArchiInfoFromPayload(
                  detail?.properties?.archiInfo,
                  payload,
                  outgoingEditedFields
                )
              }
            }))
          : current.selectedBuildingDetails;
        const nextBuildingDetails = canPatchSelectedDetails
          ? nextSelectedBuildingDetails[0] || current.buildingDetails
          : (isSameSelection
            ? {
                ...current.buildingDetails,
                review_status: savedReviewStatus,
                user_edit_id: Number.isInteger(savedEditId) && savedEditId > 0 ? savedEditId : current.buildingDetails?.user_edit_id ?? null,
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
            : current.buildingDetails);

        return {
          ...current,
          buildingDetails: nextBuildingDetails,
          selectedBuildingDetails: nextSelectedBuildingDetails,
          saveStatus: isBulkSelection
            ? translateNow('buildingModal.bulkSaved', { count: saveTargets.length })
            : translateNow('mapPage.submitted')
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
