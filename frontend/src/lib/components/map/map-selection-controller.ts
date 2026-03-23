import {
  getCurrentBuildingsFillLayerIds,
  getCurrentBuildingsLineLayerIds,
  getCurrentBuildingPartFillLayerIds,
  getCurrentBuildingPartLineLayerIds,
  getCurrentSelectedFillLayerIds,
  getCurrentSelectedLineLayerIds
} from '../../services/map/map-layer-utils.js';
import {
  SEARCH_RESULTS_CLUSTER_LAYER_ID,
  SEARCH_RESULTS_LAYER_ID,
  SEARCH_RESULTS_SOURCE_ID
} from '../../services/map/map-search-utils.js';
import { encodeOsmFeatureId, getFeatureIdentity, getSelectionFilter } from './selection-utils.js';

export function createMapSelectionController({
  getMap,
  getActiveRegions,
  recordDebugSetFilter,
  debugSelectionLog,
  dispatchBuildingClick
}: LooseRecord = {}) {
  let lastHandledBuildingClickSig = null;

  function getPrimaryBuildingFeature(event) {
    const map = getMap?.();
    if (!map) return null;
    const searchFeatures = map.queryRenderedFeatures(event.point, {
      layers: [SEARCH_RESULTS_CLUSTER_LAYER_ID, SEARCH_RESULTS_LAYER_ID]
    });
    if (Array.isArray(searchFeatures) && searchFeatures.length > 0) {
      return null;
    }
    const activeRegions = getActiveRegions?.() || [];
    const buildingLayerIds = [
      ...getCurrentBuildingsLineLayerIds(activeRegions),
      ...getCurrentBuildingsFillLayerIds(activeRegions),
      ...getCurrentBuildingPartLineLayerIds(activeRegions),
      ...getCurrentBuildingPartFillLayerIds(activeRegions)
    ];
    if (buildingLayerIds.length === 0) return null;
    const features = map.queryRenderedFeatures(event.point, {
      layers: buildingLayerIds
    });
    return features?.[0] || null;
  }

  function focusSelectedFeature({ feature, identity, lngLat }: LooseRecord) {
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

    if (!lngLat) return;
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

  function selectBuildingOnMap({ source, feature, identity, lngLat, lon = null, lat = null }: LooseRecord) {
    focusSelectedFeature({ feature, identity, lngLat });
    debugSelectionLog?.('building-click', {
      source,
      layerId: feature?.layer?.id || null,
      featureId: feature?.id ?? null,
      properties: feature?.properties || null,
      selectionKey: `${identity.osmType}/${identity.osmId}`
    });
    dispatchBuildingClick?.({
      ...identity,
      lon: Number.isFinite(Number(lon)) ? Number(lon) : null,
      lat: Number.isFinite(Number(lat)) ? Number(lat) : null,
      feature
    });
  }

  function handleMapBuildingClick(event) {
    const feature = getPrimaryBuildingFeature(event);
    if (!feature) return;
    const identity = getFeatureIdentity(feature);
    if (!identity) return;
    const clickSig = `${event?.originalEvent?.timeStamp || ''}:${event?.point?.x || ''}:${event?.point?.y || ''}:${identity.osmType}/${identity.osmId}`;
    if (clickSig === lastHandledBuildingClickSig) return;
    lastHandledBuildingClickSig = clickSig;
    selectBuildingOnMap({
      source: 'map-click',
      feature,
      identity,
      lngLat: event?.lngLat
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

  function applySelectionFromStore(selection) {
    const map = getMap?.();
    if (!map || !selection?.osmType || !selection?.osmId) return;
    const activeRegions = getActiveRegions?.() || [];
    const identity = {
      osmType: selection.osmType,
      osmId: Number(selection.osmId)
    };
    const filter = getSelectionFilter(null, identity);
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

  function onSearchClusterClick(event) {
    const map = getMap?.();
    const feature = event?.features?.[0];
    if (!map || !feature) return;
    const clusterId = feature.properties?.cluster_id;
    const coordinates = feature.geometry?.coordinates;
    const source = map.getSource(SEARCH_RESULTS_SOURCE_ID);
    if (!source || clusterId == null || !Array.isArray(coordinates)) return;
    source.getClusterExpansionZoom(clusterId, (error, zoom) => {
      if (error) return;
      map.easeTo({
        center: coordinates,
        zoom: Number.isFinite(zoom) ? zoom : Math.max(map.getZoom() + 1, 14),
        duration: 350,
        essential: true
      });
    });
  }

  function onSearchResultClick(event) {
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
  }

  return {
    applySelectionFromStore,
    clearSelectedFeature,
    destroy,
    handleMapBuildingClick,
    onSearchClusterClick,
    onSearchResultClick
  };
}
