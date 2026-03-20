import { resolvePmtilesUrl } from '../map-runtime.js';
import { buildRegionLayerId, buildRegionSourceId } from '../region-pmtiles.js';
import { getBuildingThemePaint } from './map-theme-utils.js';
import {
  EMPTY_LAYER_FILTER,
  buildFilterHighlightExpression
} from '../../components/map/filter-highlight-utils.js';
import {
  buildSearchMarkersGeojson,
  MAP_PIN_COLOR,
  MAP_PIN_INK,
  SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID,
  SEARCH_RESULTS_CLUSTER_LAYER_ID,
  SEARCH_RESULTS_LAYER_ID,
  SEARCH_RESULTS_SOURCE_ID
} from './map-search-utils.js';

export const CARTO_BUILDING_LAYER_IDS = Object.freeze(['building', 'building-top']);
export const BUILDING_FEATURE_KIND = 'building';
export const BUILDING_PART_FEATURE_KIND = 'building_part';

function buildFeatureKindFilter(featureKind = BUILDING_FEATURE_KIND) {
  if (featureKind === BUILDING_PART_FEATURE_KIND) {
    return ['==', ['coalesce', ['get', 'feature_kind'], BUILDING_FEATURE_KIND], BUILDING_PART_FEATURE_KIND];
  }
  if (featureKind === 'any') {
    return null;
  }
  return ['!=', ['coalesce', ['get', 'feature_kind'], BUILDING_FEATURE_KIND], BUILDING_PART_FEATURE_KIND];
}

function buildFeatureIdFilter(featureIds = []) {
  return buildFilterHighlightExpression({
    encodedIds: Array.isArray(featureIds) ? featureIds : []
  }).expr;
}

export function buildRegionBuildingLayerFilterExpression({
  featureIds = [],
  featureKind = BUILDING_FEATURE_KIND,
  active = false
} = {}) {
  const kindFilter = buildFeatureKindFilter(featureKind);
  const idFilter = buildFeatureIdFilter(featureIds);
  if (!active) {
    return kindFilter || EMPTY_LAYER_FILTER;
  }
  if (!kindFilter) return idFilter;
  return ['all', kindFilter, idFilter];
}

export function buildRegionBuildingHighlightFilterExpression({
  featureIds = [],
  showBuildingParts = true
} = {}) {
  const idFilter = buildFeatureIdFilter(featureIds);
  if (showBuildingParts) return idFilter;
  const buildingOnlyFilter = buildFeatureKindFilter(BUILDING_FEATURE_KIND);
  return buildingOnlyFilter ? ['all', buildingOnlyFilter, idFilter] : idFilter;
}

export function getCurrentBuildingSourceConfigs(activeRegionPmtiles = []) {
  return activeRegionPmtiles.map((region) => ({
    regionId: region.id,
    sourceId: buildRegionSourceId(region.id),
    sourceLayer: region.sourceLayer
  }));
}

export function getRegionLayerIds(activeRegionPmtiles = [], suffix) {
  return activeRegionPmtiles.map((region) => buildRegionLayerId(region.id, suffix));
}

export function getCurrentBuildingsFillLayerIds(activeRegionPmtiles = []) {
  return getRegionLayerIds(activeRegionPmtiles, 'fill');
}

export function getCurrentBuildingsLineLayerIds(activeRegionPmtiles = []) {
  return getRegionLayerIds(activeRegionPmtiles, 'line');
}

export function getCurrentBuildingPartFillLayerIds(activeRegionPmtiles = []) {
  return getRegionLayerIds(activeRegionPmtiles, 'part-fill');
}

export function getCurrentBuildingPartLineLayerIds(activeRegionPmtiles = []) {
  return getRegionLayerIds(activeRegionPmtiles, 'part-line');
}

export function getCurrentBuildingPartFilterHighlightFillLayerIds(activeRegionPmtiles = []) {
  return getRegionLayerIds(activeRegionPmtiles, 'part-filter-highlight-fill');
}

export function getCurrentBuildingPartFilterHighlightLineLayerIds(activeRegionPmtiles = []) {
  return getRegionLayerIds(activeRegionPmtiles, 'part-filter-highlight-line');
}

export function getCurrentFilterHighlightFillLayerIds(activeRegionPmtiles = []) {
  return getRegionLayerIds(activeRegionPmtiles, 'filter-highlight-fill');
}

export function getCurrentFilterHighlightLineLayerIds(activeRegionPmtiles = []) {
  return getRegionLayerIds(activeRegionPmtiles, 'filter-highlight-line');
}

export function getCurrentSelectedFillLayerIds(activeRegionPmtiles = []) {
  return getRegionLayerIds(activeRegionPmtiles, 'selected-fill');
}

export function getCurrentSelectedLineLayerIds(activeRegionPmtiles = []) {
  return getRegionLayerIds(activeRegionPmtiles, 'selected-line');
}

export function applyBuildingThemePaint({
  map,
  theme,
  fillLayerIds = [],
  lineLayerIds = [],
  partFillLayerIds = [],
  partLineLayerIds = []
}) {
  if (!map) return;
  const paint = getBuildingThemePaint(theme);
  for (const layerId of [...new Set([...fillLayerIds, ...partFillLayerIds])]) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, 'fill-color', paint.fillColor);
    map.setPaintProperty(layerId, 'fill-opacity', paint.fillOpacity);
  }
  for (const layerId of [...new Set([...lineLayerIds, ...partLineLayerIds])]) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, 'line-color', paint.lineColor);
    map.setPaintProperty(layerId, 'line-width', paint.lineWidth);
    if (paint.lineOpacity != null) {
      map.setPaintProperty(layerId, 'line-opacity', paint.lineOpacity);
    }
  }
}

export function bindMapInteractionHandlers({
  map,
  buildingFillLayerIds = [],
  buildingLineLayerIds = [],
  buildingPartFillLayerIds = [],
  buildingPartLineLayerIds = [],
  onBuildingClick,
  onSearchClusterClick,
  onSearchResultClick,
  onPointerEnter,
  onPointerLeave
}) {
  if (!map) return;
  const fillLayerIds = [...new Set(buildingFillLayerIds)];
  const lineLayerIds = [...new Set(buildingLineLayerIds)];
  const partFillLayerIds = [...new Set(buildingPartFillLayerIds)];
  const partLineLayerIds = [...new Set(buildingPartLineLayerIds)];
  map.off('click', onBuildingClick);
  map.off('click', SEARCH_RESULTS_CLUSTER_LAYER_ID, onSearchClusterClick);
  map.off('click', SEARCH_RESULTS_LAYER_ID, onSearchResultClick);
  map.off('mouseenter', SEARCH_RESULTS_CLUSTER_LAYER_ID, onPointerEnter);
  map.off('mouseleave', SEARCH_RESULTS_CLUSTER_LAYER_ID, onPointerLeave);
  map.off('mouseenter', SEARCH_RESULTS_LAYER_ID, onPointerEnter);
  map.off('mouseleave', SEARCH_RESULTS_LAYER_ID, onPointerLeave);
  for (const layerId of fillLayerIds) {
    if (!map.getLayer(layerId)) continue;
    map.off('mouseenter', layerId, onPointerEnter);
    map.off('mouseleave', layerId, onPointerLeave);
  }
  for (const layerId of lineLayerIds) {
    if (!map.getLayer(layerId)) continue;
    map.off('mouseenter', layerId, onPointerEnter);
    map.off('mouseleave', layerId, onPointerLeave);
  }
  for (const layerId of partFillLayerIds) {
    if (!map.getLayer(layerId)) continue;
    map.off('mouseenter', layerId, onPointerEnter);
    map.off('mouseleave', layerId, onPointerLeave);
  }
  for (const layerId of partLineLayerIds) {
    if (!map.getLayer(layerId)) continue;
    map.off('mouseenter', layerId, onPointerEnter);
    map.off('mouseleave', layerId, onPointerLeave);
  }

  map.on('click', onBuildingClick);
  map.on('click', SEARCH_RESULTS_CLUSTER_LAYER_ID, onSearchClusterClick);
  map.on('click', SEARCH_RESULTS_LAYER_ID, onSearchResultClick);
  map.on('mouseenter', SEARCH_RESULTS_CLUSTER_LAYER_ID, onPointerEnter);
  map.on('mouseleave', SEARCH_RESULTS_CLUSTER_LAYER_ID, onPointerLeave);
  map.on('mouseenter', SEARCH_RESULTS_LAYER_ID, onPointerEnter);
  map.on('mouseleave', SEARCH_RESULTS_LAYER_ID, onPointerLeave);
  for (const layerId of fillLayerIds) {
    if (!map.getLayer(layerId)) continue;
    map.on('mouseenter', layerId, onPointerEnter);
    map.on('mouseleave', layerId, onPointerLeave);
  }
  for (const layerId of lineLayerIds) {
    if (!map.getLayer(layerId)) continue;
    map.on('mouseenter', layerId, onPointerEnter);
    map.on('mouseleave', layerId, onPointerLeave);
  }
  for (const layerId of partFillLayerIds) {
    if (!map.getLayer(layerId)) continue;
    map.on('mouseenter', layerId, onPointerEnter);
    map.on('mouseleave', layerId, onPointerLeave);
  }
  for (const layerId of partLineLayerIds) {
    if (!map.getLayer(layerId)) continue;
    map.on('mouseenter', layerId, onPointerEnter);
    map.on('mouseleave', layerId, onPointerLeave);
  }
}

export function isBaseLabelLayer(layer) {
  if (!layer || layer.type !== 'symbol') return false;
  const id = String(layer.id || '').toLowerCase();
  if (id === SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID) return false;
  if (id.startsWith('search-results-')) return false;
  return true;
}

export function applyLabelLayerVisibility(map, visible) {
  if (!map || !map.isStyleLoaded()) return;
  const layers = map.getStyle()?.layers || [];
  const nextVisibility = visible ? 'visible' : 'none';
  for (const layer of layers) {
    if (!isBaseLabelLayer(layer)) continue;
    if (!map.getLayer(layer.id)) continue;
    map.setLayoutProperty(layer.id, 'visibility', nextVisibility);
  }
}

export function ensureSearchResultsSourceAndLayers(map, items) {
  if (!map) return;
  if (!map.getSource(SEARCH_RESULTS_SOURCE_ID)) {
    map.addSource(SEARCH_RESULTS_SOURCE_ID, {
      type: 'geojson',
      data: buildSearchMarkersGeojson(items),
      cluster: true,
      clusterRadius: 48,
      clusterMaxZoom: 16
    });
  }

  if (!map.getLayer(SEARCH_RESULTS_CLUSTER_LAYER_ID)) {
    map.addLayer({
      id: SEARCH_RESULTS_CLUSTER_LAYER_ID,
      type: 'circle',
      source: SEARCH_RESULTS_SOURCE_ID,
      filter: ['has', 'point_count'],
      paint: {
        'circle-radius': ['step', ['get', 'point_count'], 16, 12, 19, 30, 22, 60, 26],
        'circle-color': MAP_PIN_COLOR,
        'circle-stroke-color': MAP_PIN_INK,
        'circle-stroke-width': 2,
        'circle-opacity': 0.92
      }
    });
  }

  if (!map.getLayer(SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID)) {
    map.addLayer({
      id: SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID,
      type: 'symbol',
      source: SEARCH_RESULTS_SOURCE_ID,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['to-string', ['get', 'point_count']],
        'text-font': ['Open Sans Bold'],
        'text-size': 12
      },
      paint: {
        'text-color': MAP_PIN_INK
      }
    });
  }

  if (!map.getLayer(SEARCH_RESULTS_LAYER_ID)) {
    map.addLayer({
      id: SEARCH_RESULTS_LAYER_ID,
      type: 'circle',
      source: SEARCH_RESULTS_SOURCE_ID,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 14, 6, 16, 7],
        'circle-color': MAP_PIN_COLOR,
        'circle-stroke-color': MAP_PIN_INK,
        'circle-stroke-width': 2,
        'circle-opacity': 0.9
      }
    });
  }
}

export function bringSearchResultsLayersToFront(map) {
  if (!map) return;
  const orderedLayerIds = [
    SEARCH_RESULTS_CLUSTER_LAYER_ID,
    SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID,
    SEARCH_RESULTS_LAYER_ID
  ];
  for (const layerId of orderedLayerIds) {
    if (!map.getLayer(layerId)) continue;
    map.moveLayer(layerId);
  }
}

export function ensureRegionBuildingSourceAndLayers({
  map,
  region,
  buildingPaint,
  origin,
  buildingPartsVisible = true,
  buildingPartHighlightVisible = false
}) {
  if (!map || !region) return;
  const sourceId = buildRegionSourceId(region.id);
  const fillLayerId = buildRegionLayerId(region.id, 'fill');
  const lineLayerId = buildRegionLayerId(region.id, 'line');
  const partFillLayerId = buildRegionLayerId(region.id, 'part-fill');
  const partLineLayerId = buildRegionLayerId(region.id, 'part-line');
  const filterFillLayerId = buildRegionLayerId(region.id, 'filter-highlight-fill');
  const filterLineLayerId = buildRegionLayerId(region.id, 'filter-highlight-line');
  const partFilterFillLayerId = buildRegionLayerId(region.id, 'part-filter-highlight-fill');
  const partFilterLineLayerId = buildRegionLayerId(region.id, 'part-filter-highlight-line');
  const selectedFillLayerId = buildRegionLayerId(region.id, 'selected-fill');
  const selectedLineLayerId = buildRegionLayerId(region.id, 'selected-line');
  const pmtilesUrl = resolvePmtilesUrl(region.url, origin);

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: 'vector',
      url: `pmtiles://${pmtilesUrl}`
    });
  }

  if (!map.getLayer(fillLayerId)) {
    map.addLayer({
      id: fillLayerId,
      type: 'fill',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: buildRegionBuildingLayerFilterExpression(),
      paint: {
        'fill-color': buildingPaint.fillColor,
        'fill-opacity': buildingPaint.fillOpacity
      }
    });
  }

  if (!map.getLayer(lineLayerId)) {
    map.addLayer({
      id: lineLayerId,
      type: 'line',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: buildRegionBuildingLayerFilterExpression(),
      paint: {
        'line-color': buildingPaint.lineColor,
        'line-width': buildingPaint.lineWidth,
        'line-opacity': buildingPaint.lineOpacity ?? 1
      }
    });
  }

  if (!map.getLayer(partFillLayerId)) {
    map.addLayer({
      id: partFillLayerId,
      type: 'fill',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: buildRegionBuildingLayerFilterExpression({
        featureKind: BUILDING_PART_FEATURE_KIND
      }),
      layout: {
        visibility: buildingPartsVisible ? 'visible' : 'none'
      },
      paint: {
        'fill-color': buildingPaint.fillColor,
        'fill-opacity': buildingPaint.fillOpacity
      }
    });
  }

  if (!map.getLayer(partLineLayerId)) {
    map.addLayer({
      id: partLineLayerId,
      type: 'line',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: buildRegionBuildingLayerFilterExpression({
        featureKind: BUILDING_PART_FEATURE_KIND
      }),
      layout: {
        visibility: buildingPartsVisible ? 'visible' : 'none'
      },
      paint: {
        'line-color': buildingPaint.lineColor,
        'line-width': buildingPaint.lineWidth,
        'line-opacity': buildingPaint.lineOpacity ?? 1
      }
    });
  }

  if (!map.getLayer(filterFillLayerId)) {
    map.addLayer({
      id: filterFillLayerId,
      type: 'fill',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      paint: {
        'fill-color': 'transparent',
        'fill-opacity': 0
      }
    });
  }

  if (!map.getLayer(filterLineLayerId)) {
    map.addLayer({
      id: filterLineLayerId,
      type: 'line',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      paint: {
        'line-color': 'transparent',
        'line-width': 0,
        'line-opacity': 0
      }
    });
  }

  if (!map.getLayer(partFilterFillLayerId)) {
    map.addLayer({
      id: partFilterFillLayerId,
      type: 'fill',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: buildingPartHighlightVisible ? 'visible' : 'none'
      },
      paint: {
        'fill-color': 'transparent',
        'fill-opacity': 0
      }
    });
  }

  if (!map.getLayer(partFilterLineLayerId)) {
    map.addLayer({
      id: partFilterLineLayerId,
      type: 'line',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: buildingPartHighlightVisible ? 'visible' : 'none'
      },
      paint: {
        'line-color': 'transparent',
        'line-width': 0,
        'line-opacity': 0
      }
    });
  }

  if (!map.getLayer(selectedFillLayerId)) {
    map.addLayer({
      id: selectedFillLayerId,
      type: 'fill',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: ['==', ['id'], -1],
      paint: {
        'fill-color': '#6d655b',
        'fill-opacity': 0.72
      }
    });
  }

  if (!map.getLayer(selectedLineLayerId)) {
    map.addLayer({
      id: selectedLineLayerId,
      type: 'line',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: ['==', ['id'], -1],
      paint: {
        'line-color': '#3d3832',
        'line-width': 2.2
      }
    });
  }
}

export function removeRegionBuildingSourceAndLayers(map, regionId) {
  if (!map) return;
  const layerIds = [
    buildRegionLayerId(regionId, 'selected-line'),
    buildRegionLayerId(regionId, 'selected-fill'),
    buildRegionLayerId(regionId, 'part-filter-highlight-line'),
    buildRegionLayerId(regionId, 'part-filter-highlight-fill'),
    buildRegionLayerId(regionId, 'filter-highlight-line'),
    buildRegionLayerId(regionId, 'filter-highlight-fill'),
    buildRegionLayerId(regionId, 'part-line'),
    buildRegionLayerId(regionId, 'part-fill'),
    buildRegionLayerId(regionId, 'line'),
    buildRegionLayerId(regionId, 'fill')
  ];
  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
  }
  const sourceId = buildRegionSourceId(regionId);
  if (map.getSource(sourceId)) {
    map.removeSource(sourceId);
  }
}

export function applyBuildingPartsLayerVisibility({
  map,
  visible,
  forceHighlightVisible = false,
  partFillLayerIds = [],
  partLineLayerIds = [],
  partFilterHighlightFillLayerIds = [],
  partFilterHighlightLineLayerIds = []
}) {
  if (!map || !map.isStyleLoaded()) return;
  const partLayerVisibility = visible ? 'visible' : 'none';
  const partHighlightVisibility = (visible || forceHighlightVisible) ? 'visible' : 'none';
  for (const layerId of [...new Set([
    ...partFillLayerIds,
    ...partLineLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', partLayerVisibility);
  }
  for (const layerId of [...new Set([
    ...partFilterHighlightFillLayerIds,
    ...partFilterHighlightLineLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', partHighlightVisibility);
  }
}
