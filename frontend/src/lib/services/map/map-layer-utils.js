import { resolvePmtilesUrl } from '$lib/services/map-runtime';
import { buildRegionLayerId, buildRegionSourceId } from '$lib/services/region-pmtiles';
import { getBuildingThemePaint } from './map-theme-utils';
import {
  buildSearchMarkersGeojson,
  MAP_PIN_COLOR,
  MAP_PIN_INK,
  SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID,
  SEARCH_RESULTS_CLUSTER_LAYER_ID,
  SEARCH_RESULTS_LAYER_ID,
  SEARCH_RESULTS_SOURCE_ID
} from './map-search-utils';

export const CARTO_BUILDING_LAYER_IDS = Object.freeze(['building', 'building-top']);

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

export function setLocalBuildingFeatureStateById({
  map,
  activeRegionPmtiles = [],
  sourceConfigs = null,
  id,
  state
}) {
  if (!map) return false;
  if (!Number.isInteger(id) || id <= 0) return false;
  const configs = Array.isArray(sourceConfigs)
    ? sourceConfigs
    : getCurrentBuildingSourceConfigs(activeRegionPmtiles);
  let applied = false;
  for (const sourceConfig of configs) {
    if (!sourceConfig?.sourceLayer) continue;
    try {
      map.setFeatureState(
        {
          source: sourceConfig.sourceId,
          sourceLayer: sourceConfig.sourceLayer,
          id
        },
        state
      );
      applied = true;
    } catch {
      // Ignore setFeatureState errors for sources or features that are not ready.
    }
  }
  return applied;
}

export function applyBuildingThemePaint({ map, theme, fillLayerIds = [], lineLayerIds = [] }) {
  if (!map) return;
  const paint = getBuildingThemePaint(theme);
  for (const layerId of fillLayerIds) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, 'fill-color', paint.fillColor);
    map.setPaintProperty(layerId, 'fill-opacity', paint.fillOpacity);
  }
  for (const layerId of lineLayerIds) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, 'line-color', paint.lineColor);
    map.setPaintProperty(layerId, 'line-width', paint.lineWidth);
  }
}

export function bindMapInteractionHandlers({
  map,
  buildingFillLayerIds = [],
  buildingLineLayerIds = [],
  onBuildingClick,
  onSearchClusterClick,
  onSearchResultClick,
  onPointerEnter,
  onPointerLeave
}) {
  if (!map) return;
  const fillLayerIds = [...new Set(buildingFillLayerIds)];
  const lineLayerIds = [...new Set(buildingLineLayerIds)];
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

export function ensureRegionBuildingSourceAndLayers({ map, region, buildingPaint, origin }) {
  if (!map || !region) return;
  const sourceId = buildRegionSourceId(region.id);
  const fillLayerId = buildRegionLayerId(region.id, 'fill');
  const lineLayerId = buildRegionLayerId(region.id, 'line');
  const filterFillLayerId = buildRegionLayerId(region.id, 'filter-highlight-fill');
  const filterLineLayerId = buildRegionLayerId(region.id, 'filter-highlight-line');
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
      paint: {
        'line-color': buildingPaint.lineColor,
        'line-width': buildingPaint.lineWidth
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
      paint: {
        'fill-color': [
          'case',
          ['boolean', ['feature-state', 'isFiltered'], false],
          ['to-color', ['feature-state', 'filterColor']],
          'transparent'
        ],
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'isFiltered'], false],
          0.4,
          0
        ]
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
      paint: {
        'line-color': [
          'case',
          ['boolean', ['feature-state', 'isFiltered'], false],
          ['to-color', ['feature-state', 'filterColor']],
          'transparent'
        ],
        'line-width': [
          'case',
          ['boolean', ['feature-state', 'isFiltered'], false],
          1.8,
          0
        ],
        'line-opacity': [
          'case',
          ['boolean', ['feature-state', 'isFiltered'], false],
          0.95,
          0
        ]
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
    buildRegionLayerId(regionId, 'filter-highlight-line'),
    buildRegionLayerId(regionId, 'filter-highlight-fill'),
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
