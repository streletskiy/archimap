import { get } from 'svelte/store';
import {
  getCurrentBuildingsFillLayerIds,
  getCurrentBuildingsLineLayerIds,
  getCurrentBuildingPartFillLayerIds,
  getCurrentBuildingPartLineLayerIds,
  getCurrentBuildingHoverFillLayerIds,
  getCurrentBuildingHoverLineLayerIds,
  getCurrentSelectedFillLayerIds,
  getCurrentSelectedLineLayerIds
} from '../../services/map/map-layer-utils.js';
import {
  SEARCH_RESULTS_CLUSTER_LAYER_ID,
  SEARCH_RESULTS_LAYER_ID,
  SEARCH_RESULTS_SOURCE_ID
} from '../../services/map/map-search-utils.js';
import { mapSelectionShiftKey } from '$lib/stores/map';
import { encodeOsmFeatureId, getFeatureIdentity, getSelectionFilter } from './selection-utils.js';
import type { FilterMapLike } from '../../services/map/filter-types.js';

type RegionLike = {
  id?: number | string;
};

type SelectionIdentity = {
  osmType: string;
  osmId: number;
};

type SelectionLngLat = {
  lng: number;
  lat: number;
};

type SelectionPointLike = {
  x?: number;
  y?: number;
};

type SelectionFeatureLike = {
  layer?: { id?: string };
  id?: number | string | null;
  properties?: Record<string, unknown> | null;
  geometry?: {
    coordinates?: unknown;
  } | null;
} | null | undefined;

type SelectionDispatchPayload = SelectionIdentity & {
  lon: number | null;
  lat: number | null;
  shiftKey: boolean;
  featureKind: string | null;
  feature: SelectionFeatureLike;
};

type MapSelectionControllerOptions = {
  getMap?: () => FilterMapLike | null | undefined;
  getActiveRegions?: () => RegionLike[] | null | undefined;
  recordDebugSetFilter?: (layerId: string) => void;
  debugSelectionLog?: (eventName: string, payload?: Record<string, unknown>) => void;
  dispatchBuildingClick?: (payload: SelectionDispatchPayload) => void;
};

export function createMapSelectionController({
  getMap,
  getActiveRegions,
  recordDebugSetFilter,
  debugSelectionLog,
  dispatchBuildingClick
}: MapSelectionControllerOptions = {}) {
  let lastHandledBuildingClickSig: string | null = null;
  let lastHoveredBuildingSig: string | null = null;
  let lastPointerPoint: SelectionPointLike | null = null;
  // Thin PMTiles contour strokes need a small buffer so hover can catch the edge.
  const BUILDING_HIT_BUFFER_PX = 4;

  function getFeatureKind(feature: SelectionFeatureLike) {
    return String(feature?.properties?.feature_kind || '').trim() || null;
  }

  function getEventShiftKey(event: {
    shiftKey?: boolean;
    originalEvent?: {
      shiftKey?: boolean;
      getModifierState?: (key: string) => boolean;
      srcEvent?: { shiftKey?: boolean };
    };
    srcEvent?: { shiftKey?: boolean };
  } | null | undefined) {
    if (event?.shiftKey) return true;
    if (event?.srcEvent?.shiftKey) return true;
    if (event?.originalEvent?.shiftKey) return true;
    if (event?.originalEvent?.srcEvent?.shiftKey) return true;
    if (typeof event?.originalEvent?.getModifierState === 'function') {
      try {
        if (event.originalEvent.getModifierState('Shift')) return true;
      } catch {
        // ignore modifier-state lookup failures from synthetic event wrappers
      }
    }
    return Boolean(get(mapSelectionShiftKey));
  }

  function getNormalizedPoint(point: SelectionPointLike | null | undefined) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function setMapCursor(nextCursor: string) {
    const map = getMap?.();
    const canvas = map?.getCanvas?.();
    if (!canvas?.style) return;
    const normalizedCursor = String(nextCursor || '');
    if (canvas.style.cursor === normalizedCursor) return;
    canvas.style.cursor = normalizedCursor;
  }

  function getHoverLayerIds(activeRegions: RegionLike[] = []) {
    return {
      hoverFillLayerIds: getCurrentBuildingHoverFillLayerIds(activeRegions),
      hoverLineLayerIds: getCurrentBuildingHoverLineLayerIds(activeRegions)
    };
  }

  function getRenderableLayerIds(layerIds: string[] = []) {
    const map = getMap?.();
    if (!map) return [];
    return [...new Set(
      (Array.isArray(layerIds) ? layerIds : [])
        .map((layerId) => String(layerId || '').trim())
        .filter((layerId) => layerId && Boolean(map.getLayer(layerId)))
    )];
  }

  function clearHoveredBuilding({ force = false }: { force?: boolean } = {}) {
    const map = getMap?.();
    if (!map) {
      lastHoveredBuildingSig = null;
      return;
    }
    if (!force && lastHoveredBuildingSig == null) return;
    const activeRegions = getActiveRegions?.() || [];
    const { hoverFillLayerIds, hoverLineLayerIds } = getHoverLayerIds(activeRegions);
    for (const layerId of hoverFillLayerIds) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, ['==', ['id'], -1]);
    }
    for (const layerId of hoverLineLayerIds) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, ['==', ['id'], -1]);
    }
    lastHoveredBuildingSig = null;
  }

  function applyHoveredBuilding({
    feature,
    identity,
    force = false
  }: {
    feature: SelectionFeatureLike;
    identity: SelectionIdentity;
    force?: boolean;
  }) {
    const map = getMap?.();
    if (!map) return;
    const hoverKey = `${identity?.osmType || '?'}/${identity?.osmId || '?'}`;
    if (!force && hoverKey === lastHoveredBuildingSig) return;
    const activeRegions = getActiveRegions?.() || [];
    const filter = getSelectionFilter(feature, identity);
    const { hoverFillLayerIds, hoverLineLayerIds } = getHoverLayerIds(activeRegions);
    for (const layerId of hoverFillLayerIds) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
    }
    for (const layerId of hoverLineLayerIds) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
    }
    lastHoveredBuildingSig = hoverKey;
  }

  function getPrimaryBuildingFeature(event: { point?: SelectionPointLike | null }) {
    const map = getMap?.();
    if (!map) return null;
    if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) return null;
    const normalizedPoint = getNormalizedPoint(event?.point);
    if (!normalizedPoint) return null;
    const searchLayerIds = getRenderableLayerIds([SEARCH_RESULTS_CLUSTER_LAYER_ID, SEARCH_RESULTS_LAYER_ID]);
    const searchFeatures = searchLayerIds.length > 0
      ? map.queryRenderedFeatures(normalizedPoint, {
          layers: searchLayerIds
        })
      : [];
    if (Array.isArray(searchFeatures) && searchFeatures.length > 0) {
      return null;
    }
    const activeRegions = getActiveRegions?.() || [];
    const buildingLayerIds = getRenderableLayerIds([
      ...getCurrentBuildingsLineLayerIds(activeRegions),
      ...getCurrentBuildingsFillLayerIds(activeRegions),
      ...getCurrentBuildingPartLineLayerIds(activeRegions),
      ...getCurrentBuildingPartFillLayerIds(activeRegions)
    ]);
    if (buildingLayerIds.length === 0) return null;
    const queryBounds = [
      [normalizedPoint.x - BUILDING_HIT_BUFFER_PX, normalizedPoint.y - BUILDING_HIT_BUFFER_PX],
      [normalizedPoint.x + BUILDING_HIT_BUFFER_PX, normalizedPoint.y + BUILDING_HIT_BUFFER_PX]
    ];
    const features = map.queryRenderedFeatures(queryBounds, {
      layers: buildingLayerIds
    });
    return features?.[0] || null;
  }

  function handleMapPointerMove(event: {
    point?: SelectionPointLike | null;
  }, { forceHover = false }: { forceHover?: boolean } = {}) {
    const map = getMap?.();
    if (!map) return;
    if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) {
      clearHoveredBuilding({ force: true });
      setMapCursor('');
      return;
    }
    const normalizedPoint = getNormalizedPoint(event?.point);
    if (!normalizedPoint) {
      clearHoveredBuilding();
      setMapCursor('');
      lastPointerPoint = null;
      return;
    }
    lastPointerPoint = { x: normalizedPoint.x, y: normalizedPoint.y };

    const searchLayerIds = getRenderableLayerIds([SEARCH_RESULTS_CLUSTER_LAYER_ID, SEARCH_RESULTS_LAYER_ID]);
    const searchFeatures = searchLayerIds.length > 0
      ? map.queryRenderedFeatures(normalizedPoint, {
          layers: searchLayerIds
        })
      : [];
    if (Array.isArray(searchFeatures) && searchFeatures.length > 0) {
      clearHoveredBuilding();
      setMapCursor('pointer');
      return;
    }

    const activeRegions = getActiveRegions?.() || [];
    const buildingLayerIds = getRenderableLayerIds([
      ...getCurrentBuildingsLineLayerIds(activeRegions),
      ...getCurrentBuildingsFillLayerIds(activeRegions),
      ...getCurrentBuildingPartLineLayerIds(activeRegions),
      ...getCurrentBuildingPartFillLayerIds(activeRegions)
    ]);
    if (buildingLayerIds.length === 0) {
      clearHoveredBuilding();
      setMapCursor('');
      return;
    }

    const queryBounds = [
      [normalizedPoint.x - BUILDING_HIT_BUFFER_PX, normalizedPoint.y - BUILDING_HIT_BUFFER_PX],
      [normalizedPoint.x + BUILDING_HIT_BUFFER_PX, normalizedPoint.y + BUILDING_HIT_BUFFER_PX]
    ];
    const features = map.queryRenderedFeatures(queryBounds, {
      layers: buildingLayerIds
    });
    const feature = Array.isArray(features) ? features[0] : null;
    const identity = feature ? getFeatureIdentity(feature) : null;
    if (!feature || !identity) {
      clearHoveredBuilding();
      setMapCursor('');
      return;
    }

    applyHoveredBuilding({
      feature,
      identity,
      force: forceHover
    });
    setMapCursor('pointer');
  }

  function handleMapPointerLeave() {
    clearHoveredBuilding();
    setMapCursor('');
    lastPointerPoint = null;
  }

  function refreshHoverFromLastPointer() {
    if (!lastPointerPoint) {
      clearHoveredBuilding({ force: true });
      setMapCursor('');
      return;
    }
    handleMapPointerMove({ point: lastPointerPoint }, { forceHover: true });
  }

  function focusSelectedFeature({
    feature,
    identity,
    lngLat,
    shouldZoom = true
  }: {
    feature: SelectionFeatureLike;
    identity: SelectionIdentity;
    lngLat?: SelectionLngLat | null;
    shouldZoom?: boolean;
  }) {
    const map = getMap?.();
    if (!map) return;
    const activeRegions = getActiveRegions?.() || [];
    const filter = getSelectionFilter(feature, identity);
    const selectionKey = `${identity?.osmType || '?'}/${identity?.osmId || '?'}`;
    for (const layerId of getCurrentSelectedFillLayerIds(activeRegions)) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
      recordDebugSetFilter?.(layerId);
    }
    for (const layerId of getCurrentSelectedLineLayerIds(activeRegions)) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
      recordDebugSetFilter?.(layerId);
    }
    debugSelectionLog?.('highlight-applied', {
      method: 'setFilter',
      selectionKey,
      encodedId: identity?.osmType && Number.isInteger(identity?.osmId)
        ? encodeOsmFeatureId(identity.osmType, identity.osmId)
        : null
    });

    if (!lngLat || !shouldZoom) return;
    const desktopOffsetX = typeof window !== 'undefined' && window.innerWidth >= 1024
      ? -Math.round(window.innerWidth * 0.18)
      : 0;
    debugSelectionLog?.('zoom-start', {
      selectionKey,
      center: { lon: Number(lngLat.lng), lat: Number(lngLat.lat) }
    });
    map.easeTo({
      center: lngLat,
      offset: [desktopOffsetX, 0],
      duration: 420,
      essential: true
    });
    map.once('moveend', () => {
      debugSelectionLog?.('zoom-end', {
        selectionKey
      });
    });
  }

  function selectBuildingOnMap({
    source,
    feature,
    identity,
    lngLat,
    lon = null,
    lat = null,
    shiftKey = false
  }: {
    source: string;
    feature: SelectionFeatureLike;
    identity: SelectionIdentity;
    lngLat?: SelectionLngLat | null;
    lon?: number | null;
    lat?: number | null;
    shiftKey?: boolean;
  }) {
    focusSelectedFeature({
      feature,
      identity,
      lngLat,
      shouldZoom: !shiftKey
    });
    debugSelectionLog?.('building-click', {
      source,
      shiftKey: Boolean(shiftKey),
      layerId: feature?.layer?.id || null,
      featureId: feature?.id ?? null,
      featureKind: getFeatureKind(feature),
      properties: feature?.properties || null,
      selectionKey: `${identity.osmType}/${identity.osmId}`
    });
    dispatchBuildingClick?.({
      ...identity,
      lon: Number.isFinite(Number(lon)) ? Number(lon) : null,
      lat: Number.isFinite(Number(lat)) ? Number(lat) : null,
      shiftKey: Boolean(shiftKey),
      featureKind: getFeatureKind(feature),
      feature
    });
  }

  function handleMapBuildingClick(event: {
    point?: SelectionPointLike;
    originalEvent?: { timeStamp?: number; shiftKey?: boolean };
    lngLat?: SelectionLngLat;
  }) {
    const feature = getPrimaryBuildingFeature(event);
    if (!feature) return;
    const identity = getFeatureIdentity(feature);
    if (!identity) return;
    const clickSig = `${event?.originalEvent?.timeStamp || ''}:${event?.point?.x || ''}:${event?.point?.y || ''}:${identity.osmType}/${identity.osmId}`;
    if (clickSig === lastHandledBuildingClickSig) return;
    lastHandledBuildingClickSig = clickSig;
    const shiftKey = getEventShiftKey(event);
    selectBuildingOnMap({
      source: 'map-click',
      feature,
      identity,
      lngLat: event?.lngLat,
      shiftKey
    });
  }

  function clearSelectedFeature() {
    const map = getMap?.();
    if (!map) return;
    const activeRegions = getActiveRegions?.() || [];
    for (const layerId of getCurrentSelectedFillLayerIds(activeRegions)) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, ['==', ['id'], -1]);
      recordDebugSetFilter?.(layerId);
    }
    for (const layerId of getCurrentSelectedLineLayerIds(activeRegions)) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, ['==', ['id'], -1]);
      recordDebugSetFilter?.(layerId);
    }
  }

  function applySelectionFromStore(selection: { osmType?: string | null; osmId?: number | string | null } | Array<{ osmType?: string | null; osmId?: number | string | null }> | null | undefined) {
    const map = getMap?.();
    if (!map) return;
    const activeRegions = getActiveRegions?.() || [];
    const filter = getSelectionFilter(null, selection);
    for (const layerId of getCurrentSelectedFillLayerIds(activeRegions)) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
      recordDebugSetFilter?.(layerId);
    }
    for (const layerId of getCurrentSelectedLineLayerIds(activeRegions)) {
      if (!map.getLayer(layerId)) continue;
      map.setFilter(layerId, filter);
      recordDebugSetFilter?.(layerId);
    }
  }

  function onSearchClusterClick(event: {
    features?: Array<{
      properties?: {
        cluster_id?: number | string | null;
      } | null;
      geometry?: {
        coordinates?: [number, number] | number[] | null;
      } | null;
    }>;
  }) {
    const map = getMap?.();
    const feature = event?.features?.[0];
    if (!map || !feature) return;
    const clusterId = feature.properties?.cluster_id;
    const coordinates = feature.geometry?.coordinates;
    const source = map.getSource(SEARCH_RESULTS_SOURCE_ID);
    if (!source || clusterId == null || !Array.isArray(coordinates)) return;
    source.getClusterExpansionZoom(Number(clusterId), (error, zoom) => {
      if (error) return;
      map.easeTo({
        center: coordinates,
        zoom: Number.isFinite(zoom) ? zoom : Math.max(map.getZoom() + 1, 14),
        duration: 350,
        essential: true
      });
    });
  }

  function onSearchResultClick(event: {
    features?: Array<{
      properties?: {
        osm_type?: string | null;
        osm_id?: number | string | null;
      } | null;
      geometry?: {
        coordinates?: [number, number] | number[] | null;
      } | null;
    }>;
    lngLat?: SelectionLngLat;
  }) {
    const feature = event?.features?.[0];
    if (!feature) return;
    const osmType = String(feature?.properties?.osm_type || '').trim();
    const osmId = Number(feature?.properties?.osm_id);
    if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) return;

    const lng = Number(feature?.geometry?.coordinates?.[0]);
    const lat = Number(feature?.geometry?.coordinates?.[1]);
    const lngLat = (Number.isFinite(lng) && Number.isFinite(lat)) ? { lng, lat } : event?.lngLat;
    selectBuildingOnMap({
      source: 'search-result',
      feature: null,
      identity: { osmType, osmId },
      lngLat,
      lon: lng,
      lat
    });
  }

  function destroy() {
    lastHandledBuildingClickSig = null;
    clearHoveredBuilding({ force: true });
    setMapCursor('');
    lastHoveredBuildingSig = null;
    lastPointerPoint = null;
  }

  return {
    applySelectionFromStore,
    clearSelectedFeature,
    destroy,
    handleMapBuildingClick,
    handleMapPointerLeave,
    handleMapPointerMove,
    onSearchClusterClick,
    onSearchResultClick,
    refreshHoverFromLastPointer
  };
}
