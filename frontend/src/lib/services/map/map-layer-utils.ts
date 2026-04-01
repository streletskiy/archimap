import { resolvePmtilesUrl } from '../map-runtime.js';
import { buildRegionLayerId, buildRegionSourceId } from '../region-pmtiles.js';
import { getBuildingHoverThemePaint, getBuildingThemePaint } from './map-theme-utils.js';
import {
  BUILDING_HIDE_BASE_WHEN_PARTS_PROPERTY,
  buildBuildingExtrusionBaseExpression,
  buildBuildingExtrusionHeightExpression
} from './map-3d-utils.js';
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
import { hasPositiveStyleFilterMatch } from './map-style-filter-utils.js';

export const BASEMAP_BUILDING_LAYER_IDS = Object.freeze({
  carto: Object.freeze(['building', 'building-top']),
  maptiler: Object.freeze(['Building'])
});
export const BASEMAP_SUPPRESSED_LAYER_IDS = Object.freeze({
  carto: Object.freeze([]),
  maptiler: Object.freeze(['Building 3D'])
});
export const BUILDING_FEATURE_KIND = 'building';
export const BUILDING_PART_FEATURE_KIND = 'building_part';
export const BUILDING_REMAINDER_FEATURE_KIND = 'building_remainder';
export const OVERPASS_BUILDING_SOURCE_ID = 'overpass-buildings-source';
const BUILDING_SELECTED_THEME = Object.freeze({
  fillColor: '#6d655b',
  fillOpacity: 0.72,
  lineColor: '#3d3832',
  lineWidth: 2.2,
  lineOpacity: 1
});
const OVERPASS_BUILDING_LAYER_SUFFIXES = Object.freeze({
  extrusion: 'extrusion',
  fill: 'fill',
  line: 'line',
  partExtrusion: 'part-extrusion',
  partFill: 'part-fill',
  partLine: 'part-line',
  partFilterHighlightExtrusion: 'part-filter-highlight-extrusion',
  partFilterHighlightFill: 'part-filter-highlight-fill',
  partFilterHighlightLine: 'part-filter-highlight-line',
  filterHighlightExtrusion: 'filter-highlight-extrusion',
  filterHighlightFill: 'filter-highlight-fill',
  filterHighlightLine: 'filter-highlight-line',
  hoverExtrusion: 'hover-extrusion',
  hoverFill: 'hover-fill',
  hoverLine: 'hover-line',
  selectedExtrusion: 'selected-extrusion',
  selectedFill: 'selected-fill',
  selectedLine: 'selected-line'
});

export function getBasemapBuildingLayerIds(provider = 'carto') {
  const normalizedProvider = String(provider || '').trim().toLowerCase() === 'maptiler'
    ? 'maptiler'
    : 'carto';
  return BASEMAP_BUILDING_LAYER_IDS[normalizedProvider];
}

export function getBasemapSuppressedLayerIds(provider = 'carto') {
  const normalizedProvider = String(provider || '').trim().toLowerCase() === 'maptiler'
    ? 'maptiler'
    : 'carto';
  return BASEMAP_SUPPRESSED_LAYER_IDS[normalizedProvider];
}

function buildOverpassBuildingLayerId(suffix = '') {
  const normalizedSuffix = String(suffix || '').trim();
  return normalizedSuffix ? `${OVERPASS_BUILDING_SOURCE_ID}-${normalizedSuffix}` : OVERPASS_BUILDING_SOURCE_ID;
}

export function getCurrentOverpassBuildingsFillLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.fill)];
}

export function getCurrentOverpassBuildingsExtrusionLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.extrusion)];
}

export function getCurrentOverpassBuildingsLineLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.line)];
}

export function getCurrentOverpassBuildingPartFillLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.partFill)];
}

export function getCurrentOverpassBuildingPartExtrusionLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.partExtrusion)];
}

export function getCurrentOverpassBuildingPartLineLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.partLine)];
}

export function getCurrentOverpassBuildingPartFilterHighlightFillLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.partFilterHighlightFill)];
}

export function getCurrentOverpassBuildingPartFilterHighlightExtrusionLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.partFilterHighlightExtrusion)];
}

export function getCurrentOverpassBuildingPartFilterHighlightLineLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.partFilterHighlightLine)];
}

export function getCurrentOverpassBuildingHoverExtrusionLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.hoverExtrusion)];
}

export function getCurrentOverpassBuildingHoverFillLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.hoverFill)];
}

export function getCurrentOverpassBuildingHoverLineLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.hoverLine)];
}

export function getCurrentOverpassFilterHighlightFillLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.filterHighlightFill)];
}

export function getCurrentOverpassFilterHighlightExtrusionLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.filterHighlightExtrusion)];
}

export function getCurrentOverpassFilterHighlightLineLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.filterHighlightLine)];
}

export function getCurrentOverpassSelectedExtrusionLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.selectedExtrusion)];
}

export function getCurrentOverpassSelectedFillLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.selectedFill)];
}

export function getCurrentOverpassSelectedLineLayerIds() {
  return [buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.selectedLine)];
}

function buildFeatureKindExpression() {
  return ['coalesce', ['get', 'feature_kind'], BUILDING_FEATURE_KIND];
}

function buildExactFeatureKindFilter(featureKind = BUILDING_FEATURE_KIND) {
  return ['==', buildFeatureKindExpression(), featureKind];
}

function buildVisibleBaseBuildingFilter(hideBaseWhenParts = false) {
  if (!hideBaseWhenParts) {
    return buildExactFeatureKindFilter(BUILDING_FEATURE_KIND);
  }
  return ['any',
    buildExactFeatureKindFilter(BUILDING_REMAINDER_FEATURE_KIND),
    ['all',
      buildExactFeatureKindFilter(BUILDING_FEATURE_KIND),
      ['!=', ['coalesce', ['to-number', ['get', BUILDING_HIDE_BASE_WHEN_PARTS_PROPERTY]], 0], 1]
    ]
  ];
}

function buildFeatureKindFilter(featureKind = BUILDING_FEATURE_KIND, {
  hideBaseWhenParts = false
} = {}) {
  if (featureKind === BUILDING_PART_FEATURE_KIND) {
    return buildExactFeatureKindFilter(BUILDING_PART_FEATURE_KIND);
  }
  if (featureKind === BUILDING_REMAINDER_FEATURE_KIND) {
    return buildExactFeatureKindFilter(BUILDING_REMAINDER_FEATURE_KIND);
  }
  if (featureKind === 'any') {
    return null;
  }
  return buildVisibleBaseBuildingFilter(hideBaseWhenParts);
}

function buildFeatureIdFilter(featureIds = []) {
  return buildFilterHighlightExpression({
    encodedIds: Array.isArray(featureIds) ? featureIds : []
  }).expr;
}

export function buildRegionBuildingLayerFilterExpression({
  featureIds = [],
  featureKind = BUILDING_FEATURE_KIND,
  active = false,
  hideBaseWhenParts = false
} = {}) {
  const kindFilter = buildFeatureKindFilter(featureKind, {
    hideBaseWhenParts
  });
  const idFilter = buildFeatureIdFilter(featureIds);
  const baseFilters = [kindFilter].filter(Boolean);
  if (!active) {
    if (baseFilters.length === 0) return EMPTY_LAYER_FILTER;
    if (baseFilters.length === 1) return baseFilters[0];
    return ['all', ...baseFilters];
  }
  if (baseFilters.length === 0) return idFilter;
  return ['all', ...baseFilters, idFilter];
}

export function buildVisibleBuildingSelectionScopeExpression({
  showBuildingParts = true
} = {}) {
  const baseFilter = buildVisibleBaseBuildingFilter(Boolean(showBuildingParts));
  if (!showBuildingParts) {
    return baseFilter;
  }
  return ['any', baseFilter, buildExactFeatureKindFilter(BUILDING_PART_FEATURE_KIND)];
}

export function buildRegionBuildingHighlightFilterExpression({
  featureIds = [],
  showBuildingParts = true
} = {}) {
  const idFilter = buildFeatureIdFilter(featureIds);
  const scopeFilter = buildVisibleBuildingSelectionScopeExpression({
    showBuildingParts
  });
  return scopeFilter ? ['all', scopeFilter, idFilter] : idFilter;
}

export function getCurrentBuildingSourceConfigs(activeRegionPmtiles = []) {
  return [
    ...activeRegionPmtiles.map((region) => ({
      regionId: region.id,
      sourceId: buildRegionSourceId(region.id),
      sourceLayer: region.sourceLayer
    })),
    {
      sourceId: OVERPASS_BUILDING_SOURCE_ID
    }
  ];
}

export function getRegionLayerIds(activeRegionPmtiles = [], suffix) {
  return activeRegionPmtiles.map((region) => buildRegionLayerId(region.id, suffix));
}

export function getCurrentBuildingsFillLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'fill'),
    ...getCurrentOverpassBuildingsFillLayerIds()
  ];
}

export function getCurrentBuildingsExtrusionLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'extrusion'),
    ...getCurrentOverpassBuildingsExtrusionLayerIds()
  ];
}

export function getCurrentBuildingsLineLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'line'),
    ...getCurrentOverpassBuildingsLineLayerIds()
  ];
}

export function getCurrentBuildingPartFillLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'part-fill'),
    ...getCurrentOverpassBuildingPartFillLayerIds()
  ];
}

export function getCurrentBuildingPartExtrusionLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'part-extrusion'),
    ...getCurrentOverpassBuildingPartExtrusionLayerIds()
  ];
}

export function getCurrentBuildingPartLineLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'part-line'),
    ...getCurrentOverpassBuildingPartLineLayerIds()
  ];
}

export function getCurrentBuildingPartFilterHighlightFillLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'part-filter-highlight-fill'),
    ...getCurrentOverpassBuildingPartFilterHighlightFillLayerIds()
  ];
}

export function getCurrentBuildingPartFilterHighlightExtrusionLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'part-filter-highlight-extrusion'),
    ...getCurrentOverpassBuildingPartFilterHighlightExtrusionLayerIds()
  ];
}

export function getCurrentBuildingPartFilterHighlightLineLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'part-filter-highlight-line'),
    ...getCurrentOverpassBuildingPartFilterHighlightLineLayerIds()
  ];
}

export function getCurrentBuildingHoverExtrusionLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'hover-extrusion'),
    ...getCurrentOverpassBuildingHoverExtrusionLayerIds()
  ];
}

export function getCurrentBuildingHoverFillLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'hover-fill'),
    ...getCurrentOverpassBuildingHoverFillLayerIds()
  ];
}

export function getCurrentBuildingHoverLineLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'hover-line'),
    ...getCurrentOverpassBuildingHoverLineLayerIds()
  ];
}

export function getCurrentFilterHighlightFillLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'filter-highlight-fill'),
    ...getCurrentOverpassFilterHighlightFillLayerIds()
  ];
}

export function getCurrentFilterHighlightExtrusionLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'filter-highlight-extrusion'),
    ...getCurrentOverpassFilterHighlightExtrusionLayerIds()
  ];
}

export function getCurrentFilterHighlightLineLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'filter-highlight-line'),
    ...getCurrentOverpassFilterHighlightLineLayerIds()
  ];
}

export function getCurrentSelectedExtrusionLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'selected-extrusion'),
    ...getCurrentOverpassSelectedExtrusionLayerIds()
  ];
}

export function getCurrentSelectedFillLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'selected-fill'),
    ...getCurrentOverpassSelectedFillLayerIds()
  ];
}

export function getCurrentSelectedLineLayerIds(activeRegionPmtiles = []) {
  return [
    ...getRegionLayerIds(activeRegionPmtiles, 'selected-line'),
    ...getCurrentOverpassSelectedLineLayerIds()
  ];
}

export function applyBuildingThemePaint({
  map,
  theme,
  fillLayerIds = [],
  extrusionLayerIds = [],
  lineLayerIds = [],
  partFillLayerIds = [],
  partExtrusionLayerIds = [],
  partLineLayerIds = [],
  hoverExtrusionLayerIds = [],
  hoverFillLayerIds = [],
  hoverLineLayerIds = []
}) {
  if (!map) return;
  const paint = getBuildingThemePaint(theme);
  const hoverPaint = getBuildingHoverThemePaint(theme);
  for (const layerId of [...new Set([...fillLayerIds, ...partFillLayerIds])]) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, 'fill-color', paint.fillColor);
    map.setPaintProperty(layerId, 'fill-opacity', paint.fillOpacity);
  }
  for (const layerId of [...new Set([...extrusionLayerIds, ...partExtrusionLayerIds])]) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, 'fill-extrusion-color', paint.fillColor);
    map.setPaintProperty(layerId, 'fill-extrusion-opacity', paint.fillOpacity);
  }
  for (const layerId of [...new Set([...lineLayerIds, ...partLineLayerIds])]) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, 'line-color', paint.lineColor);
    map.setPaintProperty(layerId, 'line-width', paint.lineWidth);
    if (paint.lineOpacity != null) {
      map.setPaintProperty(layerId, 'line-opacity', paint.lineOpacity);
    }
  }
  for (const layerId of [...new Set([...hoverExtrusionLayerIds])]) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, 'fill-extrusion-color', hoverPaint.fillColor);
    map.setPaintProperty(layerId, 'fill-extrusion-opacity', hoverPaint.fillOpacity);
  }
  for (const layerId of [...new Set([...hoverFillLayerIds])]) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, 'fill-color', hoverPaint.fillColor);
    map.setPaintProperty(layerId, 'fill-opacity', hoverPaint.fillOpacity);
  }
  for (const layerId of [...new Set([...hoverLineLayerIds])]) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, 'line-color', hoverPaint.lineColor);
    map.setPaintProperty(layerId, 'line-width', hoverPaint.lineWidth);
    if (hoverPaint.lineOpacity != null) {
      map.setPaintProperty(layerId, 'line-opacity', hoverPaint.lineOpacity);
    }
  }
}

function buildBuildingExtrusionPaint(buildingPaint) {
  return {
    'fill-extrusion-color': buildingPaint.fillColor,
    'fill-extrusion-opacity': buildingPaint.fillOpacity,
    'fill-extrusion-base': buildBuildingExtrusionBaseExpression(),
    'fill-extrusion-height': buildBuildingExtrusionHeightExpression(),
    'fill-extrusion-vertical-gradient': false
  };
}

function buildOverlayExtrusionPaint(color = 'transparent', opacity = 0) {
  return {
    'fill-extrusion-color': color,
    'fill-extrusion-opacity': opacity,
    'fill-extrusion-base': buildBuildingExtrusionBaseExpression(),
    'fill-extrusion-height': buildBuildingExtrusionHeightExpression(),
    'fill-extrusion-vertical-gradient': false
  };
}

function applyBaseBuildingLayerFilters(map, layerIds = [], {
  hideBaseWhenParts = false
} = {}) {
  if (!map?.setFilter) return;
  const filter = buildRegionBuildingLayerFilterExpression({
    hideBaseWhenParts
  });
  for (const layerId of [...new Set(Array.isArray(layerIds) ? layerIds : [])]) {
    if (!map.getLayer(layerId)) continue;
    map.setFilter(layerId, filter);
  }
}

export function bindMapInteractionHandlers({
  map,
  onBuildingClick,
  onSearchClusterClick,
  onSearchResultClick
}) {
  if (!map) return;
  map.off('click', onBuildingClick);
  map.off('click', SEARCH_RESULTS_CLUSTER_LAYER_ID, onSearchClusterClick);
  map.off('click', SEARCH_RESULTS_LAYER_ID, onSearchResultClick);

  map.on('click', onBuildingClick);
  map.on('click', SEARCH_RESULTS_CLUSTER_LAYER_ID, onSearchClusterClick);
  map.on('click', SEARCH_RESULTS_LAYER_ID, onSearchResultClick);
}

export function isBaseLabelLayer(layer) {
  if (!layer || layer.type !== 'symbol') return false;
  if (String(layer?.['source-layer'] || '').trim().toLowerCase() === 'poi') return false;
  if (hasPositiveStyleFilterMatch(layer?.filter, 'class', 'ferry')) return false;
  const id = String(layer.id || '').toLowerCase();
  if (id === SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID) return false;
  if (id.startsWith('search-results-')) return false;
  return true;
}

export function applyLabelLayerVisibility(map, visible) {
  if (!map) return;
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

export function bringBaseLabelLayersAboveCustomLayers(map) {
  if (!map) return;
  const layers = map.getStyle()?.layers || [];
  const searchAnchorLayerId = [
    SEARCH_RESULTS_CLUSTER_LAYER_ID,
    SEARCH_RESULTS_CLUSTER_COUNT_LAYER_ID,
    SEARCH_RESULTS_LAYER_ID
  ].find((layerId) => Boolean(map.getLayer(layerId)));

  for (const layer of layers) {
    if (!isBaseLabelLayer(layer)) continue;
    const layerId = String(layer?.id || '').trim();
    if (!layerId) continue;
    if (!map.getLayer(layerId)) continue;
    if (searchAnchorLayerId) {
      map.moveLayer(layerId, searchAnchorLayerId);
    } else {
      map.moveLayer(layerId);
    }
  }
}

function ensureLayerVisibility(map, layerId, visibility) {
  if (!map?.getLayer?.(layerId)) return;
  map.setLayoutProperty(layerId, 'visibility', visibility);
}

export function ensureOverpassBuildingSourceAndLayers({
  map,
  data,
  buildingPaint,
  hoverPaint = getBuildingHoverThemePaint('light'),
  buildings3dEnabled = false,
  buildingPartsVisible = true,
  buildingPartHighlightVisible = false,
  visible = true
}) {
  if (!map) return;
  const sourceId = OVERPASS_BUILDING_SOURCE_ID;
  const extrusionLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.extrusion);
  const fillLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.fill);
  const lineLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.line);
  const partExtrusionLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.partExtrusion);
  const partFillLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.partFill);
  const partLineLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.partLine);
  const filterExtrusionLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.filterHighlightExtrusion);
  const filterFillLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.filterHighlightFill);
  const filterLineLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.filterHighlightLine);
  const partFilterExtrusionLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.partFilterHighlightExtrusion);
  const partFilterFillLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.partFilterHighlightFill);
  const partFilterLineLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.partFilterHighlightLine);
  const hoverExtrusionLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.hoverExtrusion);
  const hoverFillLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.hoverFill);
  const hoverLineLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.hoverLine);
  const selectedExtrusionLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.selectedExtrusion);
  const selectedFillLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.selectedFill);
  const selectedLineLayerId = buildOverpassBuildingLayerId(OVERPASS_BUILDING_LAYER_SUFFIXES.selectedLine);

  const sourceData = data || {
    type: 'FeatureCollection',
    features: []
  };

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: 'geojson',
      data: sourceData
    });
  } else {
    const source = map.getSource(sourceId);
    source?.setData?.(sourceData);
  }

  if (!map.getLayer(extrusionLayerId)) {
    map.addLayer({
      id: extrusionLayerId,
      type: 'fill-extrusion',
      source: sourceId,
      minzoom: 13,
      filter: buildRegionBuildingLayerFilterExpression({
        hideBaseWhenParts: buildingPartsVisible
      }),
      paint: buildBuildingExtrusionPaint(buildingPaint),
      layout: {
        visibility: visible && buildings3dEnabled ? 'visible' : 'none'
      }
    });
  }

  if (!map.getLayer(fillLayerId)) {
    map.addLayer({
      id: fillLayerId,
      type: 'fill',
      source: sourceId,
      minzoom: 13,
      filter: buildRegionBuildingLayerFilterExpression({
        hideBaseWhenParts: buildingPartsVisible
      }),
      paint: {
        'fill-color': buildingPaint.fillColor,
        'fill-opacity': buildingPaint.fillOpacity
      },
      layout: {
        visibility: visible && !buildings3dEnabled ? 'visible' : 'none'
      }
    });
  }

  if (!map.getLayer(lineLayerId)) {
    map.addLayer({
      id: lineLayerId,
      type: 'line',
      source: sourceId,
      minzoom: 13,
      filter: buildRegionBuildingLayerFilterExpression({
        hideBaseWhenParts: buildingPartsVisible
      }),
      paint: {
        'line-color': buildingPaint.lineColor,
        'line-width': buildingPaint.lineWidth,
        'line-opacity': buildingPaint.lineOpacity ?? 1
      },
      layout: {
        visibility: visible && !buildings3dEnabled ? 'visible' : 'none'
      }
    });
  }

  if (!map.getLayer(partExtrusionLayerId)) {
    map.addLayer({
      id: partExtrusionLayerId,
      type: 'fill-extrusion',
      source: sourceId,
      minzoom: 13,
      filter: buildRegionBuildingLayerFilterExpression({
        featureKind: BUILDING_PART_FEATURE_KIND
      }),
      layout: {
        visibility: visible && buildingPartsVisible && buildings3dEnabled ? 'visible' : 'none'
      },
      paint: buildBuildingExtrusionPaint(buildingPaint)
    });
  }

  if (!map.getLayer(partFillLayerId)) {
    map.addLayer({
      id: partFillLayerId,
      type: 'fill',
      source: sourceId,
      minzoom: 13,
      filter: buildRegionBuildingLayerFilterExpression({
        featureKind: BUILDING_PART_FEATURE_KIND
      }),
      layout: {
        visibility: visible && buildingPartsVisible && !buildings3dEnabled ? 'visible' : 'none'
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
      minzoom: 13,
      filter: buildRegionBuildingLayerFilterExpression({
        featureKind: BUILDING_PART_FEATURE_KIND
      }),
      layout: {
        visibility: visible && buildingPartsVisible && !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'line-color': buildingPaint.lineColor,
        'line-width': buildingPaint.lineWidth,
        'line-opacity': buildingPaint.lineOpacity ?? 1
      }
    });
  }

  if (!map.getLayer(filterExtrusionLayerId)) {
    map.addLayer({
      id: filterExtrusionLayerId,
      type: 'fill-extrusion',
      source: sourceId,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: visible && buildings3dEnabled ? 'visible' : 'none'
      },
      paint: buildOverlayExtrusionPaint()
    });
  }

  if (!map.getLayer(filterFillLayerId)) {
    map.addLayer({
      id: filterFillLayerId,
      type: 'fill',
      source: sourceId,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: visible && !buildings3dEnabled ? 'visible' : 'none'
      },
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
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: visible && !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'line-color': 'transparent',
        'line-width': 0,
        'line-opacity': 0
      }
    });
  }

  if (!map.getLayer(partFilterExtrusionLayerId)) {
    map.addLayer({
      id: partFilterExtrusionLayerId,
      type: 'fill-extrusion',
      source: sourceId,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: visible && buildingPartHighlightVisible && buildings3dEnabled ? 'visible' : 'none'
      },
      paint: buildOverlayExtrusionPaint()
    });
  }

  if (!map.getLayer(partFilterFillLayerId)) {
    map.addLayer({
      id: partFilterFillLayerId,
      type: 'fill',
      source: sourceId,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: visible && buildingPartHighlightVisible && !buildings3dEnabled ? 'visible' : 'none'
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
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: visible && buildingPartHighlightVisible && !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'line-color': 'transparent',
        'line-width': 0,
        'line-opacity': 0
      }
    });
  }

  if (!map.getLayer(hoverExtrusionLayerId)) {
    map.addLayer({
      id: hoverExtrusionLayerId,
      type: 'fill-extrusion',
      source: sourceId,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: visible && buildings3dEnabled ? 'visible' : 'none'
      },
      paint: buildOverlayExtrusionPaint(hoverPaint.fillColor, hoverPaint.fillOpacity)
    });
  }

  if (!map.getLayer(hoverFillLayerId)) {
    map.addLayer({
      id: hoverFillLayerId,
      type: 'fill',
      source: sourceId,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: visible && !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'fill-color': hoverPaint.fillColor,
        'fill-opacity': hoverPaint.fillOpacity
      }
    });
  }

  if (!map.getLayer(hoverLineLayerId)) {
    map.addLayer({
      id: hoverLineLayerId,
      type: 'line',
      source: sourceId,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: visible && !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'line-color': hoverPaint.lineColor,
        'line-width': hoverPaint.lineWidth,
        'line-opacity': hoverPaint.lineOpacity ?? 1
      }
    });
  }

  if (!map.getLayer(selectedExtrusionLayerId)) {
    map.addLayer({
      id: selectedExtrusionLayerId,
      type: 'fill-extrusion',
      source: sourceId,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: visible && buildings3dEnabled ? 'visible' : 'none'
      },
      paint: buildOverlayExtrusionPaint(BUILDING_SELECTED_THEME.fillColor, BUILDING_SELECTED_THEME.fillOpacity)
    });
  }

  if (!map.getLayer(selectedFillLayerId)) {
    map.addLayer({
      id: selectedFillLayerId,
      type: 'fill',
      source: sourceId,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: visible && !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'fill-color': BUILDING_SELECTED_THEME.fillColor,
        'fill-opacity': BUILDING_SELECTED_THEME.fillOpacity
      }
    });
  }

  if (!map.getLayer(selectedLineLayerId)) {
    map.addLayer({
      id: selectedLineLayerId,
      type: 'line',
      source: sourceId,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: visible && !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'line-color': BUILDING_SELECTED_THEME.lineColor,
        'line-width': BUILDING_SELECTED_THEME.lineWidth,
        'line-opacity': BUILDING_SELECTED_THEME.lineOpacity
      }
    });
  }

  ensureLayerVisibility(map, extrusionLayerId, visible && buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, fillLayerId, visible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, lineLayerId, visible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, partExtrusionLayerId, visible && buildingPartsVisible && buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, partFillLayerId, visible && buildingPartsVisible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, partLineLayerId, visible && buildingPartsVisible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, filterExtrusionLayerId, visible && buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, filterFillLayerId, visible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, filterLineLayerId, visible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, partFilterExtrusionLayerId, visible && buildingPartHighlightVisible && buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, partFilterFillLayerId, visible && buildingPartHighlightVisible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, partFilterLineLayerId, visible && buildingPartHighlightVisible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, hoverExtrusionLayerId, visible && buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, hoverFillLayerId, visible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, hoverLineLayerId, visible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, selectedExtrusionLayerId, visible && buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, selectedFillLayerId, visible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, selectedLineLayerId, visible && !buildings3dEnabled ? 'visible' : 'none');
}

export function ensureRegionBuildingSourceAndLayers({
  map,
  region,
  buildingPaint,
  hoverPaint = getBuildingHoverThemePaint('light'),
  origin,
  buildings3dEnabled = false,
  buildingPartsVisible = true,
  buildingPartHighlightVisible = false
}) {
  if (!map || !region) return;
  const sourceId = buildRegionSourceId(region.id);
  const extrusionLayerId = buildRegionLayerId(region.id, 'extrusion');
  const fillLayerId = buildRegionLayerId(region.id, 'fill');
  const lineLayerId = buildRegionLayerId(region.id, 'line');
  const partExtrusionLayerId = buildRegionLayerId(region.id, 'part-extrusion');
  const partFillLayerId = buildRegionLayerId(region.id, 'part-fill');
  const partLineLayerId = buildRegionLayerId(region.id, 'part-line');
  const filterExtrusionLayerId = buildRegionLayerId(region.id, 'filter-highlight-extrusion');
  const filterFillLayerId = buildRegionLayerId(region.id, 'filter-highlight-fill');
  const filterLineLayerId = buildRegionLayerId(region.id, 'filter-highlight-line');
  const partFilterExtrusionLayerId = buildRegionLayerId(region.id, 'part-filter-highlight-extrusion');
  const partFilterFillLayerId = buildRegionLayerId(region.id, 'part-filter-highlight-fill');
  const partFilterLineLayerId = buildRegionLayerId(region.id, 'part-filter-highlight-line');
  const hoverExtrusionLayerId = buildRegionLayerId(region.id, 'hover-extrusion');
  const hoverFillLayerId = buildRegionLayerId(region.id, 'hover-fill');
  const hoverLineLayerId = buildRegionLayerId(region.id, 'hover-line');
  const selectedExtrusionLayerId = buildRegionLayerId(region.id, 'selected-extrusion');
  const selectedFillLayerId = buildRegionLayerId(region.id, 'selected-fill');
  const selectedLineLayerId = buildRegionLayerId(region.id, 'selected-line');
  const pmtilesUrl = resolvePmtilesUrl(region.url, origin);

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: 'vector',
      url: `pmtiles://${pmtilesUrl}`
    });
  }

  if (!map.getLayer(extrusionLayerId)) {
    map.addLayer({
      id: extrusionLayerId,
      type: 'fill-extrusion',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: buildRegionBuildingLayerFilterExpression({
        hideBaseWhenParts: buildingPartsVisible
      }),
      layout: {
        visibility: buildings3dEnabled ? 'visible' : 'none'
      },
      paint: buildBuildingExtrusionPaint(buildingPaint)
    });
  }

  if (!map.getLayer(fillLayerId)) {
    map.addLayer({
      id: fillLayerId,
      type: 'fill',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: buildRegionBuildingLayerFilterExpression({
        hideBaseWhenParts: buildingPartsVisible
      }),
      layout: {
        visibility: !buildings3dEnabled ? 'visible' : 'none'
      },
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
      filter: buildRegionBuildingLayerFilterExpression({
        hideBaseWhenParts: buildingPartsVisible
      }),
      layout: {
        visibility: !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'line-color': buildingPaint.lineColor,
        'line-width': buildingPaint.lineWidth,
        'line-opacity': buildingPaint.lineOpacity ?? 1
      }
    });
  }

  if (!map.getLayer(partExtrusionLayerId)) {
    map.addLayer({
      id: partExtrusionLayerId,
      type: 'fill-extrusion',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: buildRegionBuildingLayerFilterExpression({
        featureKind: BUILDING_PART_FEATURE_KIND
      }),
      layout: {
        visibility: buildingPartsVisible && buildings3dEnabled ? 'visible' : 'none'
      },
      paint: buildBuildingExtrusionPaint(buildingPaint)
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
        visibility: buildingPartsVisible && !buildings3dEnabled ? 'visible' : 'none'
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
        visibility: buildingPartsVisible && !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'line-color': buildingPaint.lineColor,
        'line-width': buildingPaint.lineWidth,
        'line-opacity': buildingPaint.lineOpacity ?? 1
      }
    });
  }

  if (!map.getLayer(filterExtrusionLayerId)) {
    map.addLayer({
      id: filterExtrusionLayerId,
      type: 'fill-extrusion',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: buildings3dEnabled ? 'visible' : 'none'
      },
      paint: buildOverlayExtrusionPaint()
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
      layout: {
        visibility: !buildings3dEnabled ? 'visible' : 'none'
      },
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
      layout: {
        visibility: !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'line-color': 'transparent',
        'line-width': 0,
        'line-opacity': 0
      }
    });
  }

  if (!map.getLayer(partFilterExtrusionLayerId)) {
    map.addLayer({
      id: partFilterExtrusionLayerId,
      type: 'fill-extrusion',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: EMPTY_LAYER_FILTER,
      layout: {
        visibility: buildingPartHighlightVisible && buildings3dEnabled ? 'visible' : 'none'
      },
      paint: buildOverlayExtrusionPaint()
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
        visibility: buildingPartHighlightVisible && !buildings3dEnabled ? 'visible' : 'none'
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
        visibility: buildingPartHighlightVisible && !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'line-color': 'transparent',
        'line-width': 0,
        'line-opacity': 0
      }
    });
  }

  if (!map.getLayer(hoverExtrusionLayerId)) {
    map.addLayer({
      id: hoverExtrusionLayerId,
      type: 'fill-extrusion',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: ['==', ['id'], -1],
      layout: {
        visibility: buildings3dEnabled ? 'visible' : 'none'
      },
      paint: buildOverlayExtrusionPaint(hoverPaint.fillColor, hoverPaint.fillOpacity)
    });
  }

  if (!map.getLayer(hoverFillLayerId)) {
    map.addLayer({
      id: hoverFillLayerId,
      type: 'fill',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: ['==', ['id'], -1],
      layout: {
        visibility: !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'fill-color': hoverPaint.fillColor,
        'fill-opacity': hoverPaint.fillOpacity
      }
    });
  }

  if (!map.getLayer(hoverLineLayerId)) {
    map.addLayer({
      id: hoverLineLayerId,
      type: 'line',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: ['==', ['id'], -1],
      layout: {
        visibility: !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'line-color': hoverPaint.lineColor,
        'line-width': hoverPaint.lineWidth,
        'line-opacity': hoverPaint.lineOpacity ?? 1
      }
    });
  }

  if (!map.getLayer(selectedExtrusionLayerId)) {
    map.addLayer({
      id: selectedExtrusionLayerId,
      type: 'fill-extrusion',
      source: sourceId,
      'source-layer': region.sourceLayer,
      minzoom: 13,
      filter: ['==', ['id'], -1],
      layout: {
        visibility: buildings3dEnabled ? 'visible' : 'none'
      },
      paint: buildOverlayExtrusionPaint(BUILDING_SELECTED_THEME.fillColor, BUILDING_SELECTED_THEME.fillOpacity)
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
      layout: {
        visibility: !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'fill-color': BUILDING_SELECTED_THEME.fillColor,
        'fill-opacity': BUILDING_SELECTED_THEME.fillOpacity
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
      layout: {
        visibility: !buildings3dEnabled ? 'visible' : 'none'
      },
      paint: {
        'line-color': BUILDING_SELECTED_THEME.lineColor,
        'line-width': BUILDING_SELECTED_THEME.lineWidth,
        'line-opacity': BUILDING_SELECTED_THEME.lineOpacity
      }
    });
  }

  ensureLayerVisibility(map, extrusionLayerId, buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, fillLayerId, !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, lineLayerId, !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, partExtrusionLayerId, buildingPartsVisible && buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, partFillLayerId, buildingPartsVisible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, partLineLayerId, buildingPartsVisible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, filterExtrusionLayerId, buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, filterFillLayerId, !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, filterLineLayerId, !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, partFilterExtrusionLayerId, buildingPartHighlightVisible && buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, partFilterFillLayerId, buildingPartHighlightVisible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, partFilterLineLayerId, buildingPartHighlightVisible && !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, hoverExtrusionLayerId, buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, hoverFillLayerId, !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, hoverLineLayerId, !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, selectedExtrusionLayerId, buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, selectedFillLayerId, !buildings3dEnabled ? 'visible' : 'none');
  ensureLayerVisibility(map, selectedLineLayerId, !buildings3dEnabled ? 'visible' : 'none');
}

export function removeRegionBuildingSourceAndLayers(map, regionId) {
  if (!map) return;
  const layerIds = [
    buildRegionLayerId(regionId, 'selected-line'),
    buildRegionLayerId(regionId, 'selected-fill'),
    buildRegionLayerId(regionId, 'selected-extrusion'),
    buildRegionLayerId(regionId, 'hover-line'),
    buildRegionLayerId(regionId, 'hover-fill'),
    buildRegionLayerId(regionId, 'hover-extrusion'),
    buildRegionLayerId(regionId, 'part-filter-highlight-line'),
    buildRegionLayerId(regionId, 'part-filter-highlight-fill'),
    buildRegionLayerId(regionId, 'part-filter-highlight-extrusion'),
    buildRegionLayerId(regionId, 'filter-highlight-line'),
    buildRegionLayerId(regionId, 'filter-highlight-fill'),
    buildRegionLayerId(regionId, 'filter-highlight-extrusion'),
    buildRegionLayerId(regionId, 'part-line'),
    buildRegionLayerId(regionId, 'part-fill'),
    buildRegionLayerId(regionId, 'part-extrusion'),
    buildRegionLayerId(regionId, 'line'),
    buildRegionLayerId(regionId, 'fill'),
    buildRegionLayerId(regionId, 'extrusion')
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
  sourceVisible = true,
  partVisible = true,
  buildings3dEnabled = false,
  fillLayerIds = [],
  extrusionLayerIds = [],
  lineLayerIds = [],
  filterHighlightExtrusionLayerIds = [],
  filterHighlightFillLayerIds = [],
  filterHighlightLineLayerIds = [],
  forceHighlightVisible = false,
  partFillLayerIds = [],
  partExtrusionLayerIds = [],
  partLineLayerIds = [],
  partFilterHighlightExtrusionLayerIds = [],
  partFilterHighlightFillLayerIds = [],
  partFilterHighlightLineLayerIds = [],
  hoverExtrusionLayerIds = [],
  hoverFillLayerIds = [],
  hoverLineLayerIds = [],
  selectedExtrusionLayerIds = [],
  selectedFillLayerIds = [],
  selectedLineLayerIds = []
}) {
  if (!map) return;
  applyBaseBuildingLayerFilters(map, [
    ...fillLayerIds,
    ...extrusionLayerIds,
    ...lineLayerIds
  ], {
    hideBaseWhenParts: partVisible
  });
  const baseFillVisibility = sourceVisible && !buildings3dEnabled ? 'visible' : 'none';
  const baseExtrusionVisibility = sourceVisible && buildings3dEnabled ? 'visible' : 'none';
  const baseLineVisibility = sourceVisible && !buildings3dEnabled ? 'visible' : 'none';
  const partLayerVisibility = sourceVisible && partVisible && !buildings3dEnabled ? 'visible' : 'none';
  const partExtrusionVisibility = sourceVisible && partVisible && buildings3dEnabled ? 'visible' : 'none';
  const partLineVisibility = sourceVisible && partVisible && !buildings3dEnabled ? 'visible' : 'none';
  const filterHighlightExtrusionVisibility = sourceVisible && buildings3dEnabled ? 'visible' : 'none';
  const filterHighlightFlatVisibility = sourceVisible && !buildings3dEnabled ? 'visible' : 'none';
  const partHighlightExtrusionVisibility = sourceVisible && (partVisible || forceHighlightVisible) && buildings3dEnabled ? 'visible' : 'none';
  const partHighlightFlatVisibility = sourceVisible && (partVisible || forceHighlightVisible) && !buildings3dEnabled ? 'visible' : 'none';
  const hoverExtrusionVisibility = sourceVisible && buildings3dEnabled ? 'visible' : 'none';
  const hoverFlatVisibility = sourceVisible && !buildings3dEnabled ? 'visible' : 'none';
  const selectedExtrusionVisibility = sourceVisible && buildings3dEnabled ? 'visible' : 'none';
  const selectedFlatVisibility = sourceVisible && !buildings3dEnabled ? 'visible' : 'none';
  for (const layerId of [...new Set([
    ...fillLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', baseFillVisibility);
  }
  for (const layerId of [...new Set([
    ...extrusionLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', baseExtrusionVisibility);
  }
  for (const layerId of [...new Set([
    ...lineLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', baseLineVisibility);
  }
  for (const layerId of [...new Set([
    ...partFillLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', partLayerVisibility);
  }
  for (const layerId of [...new Set([
    ...partExtrusionLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', partExtrusionVisibility);
  }
  for (const layerId of [...new Set([
    ...partLineLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', partLineVisibility);
  }
  for (const layerId of [...new Set([
    ...filterHighlightExtrusionLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', filterHighlightExtrusionVisibility);
  }
  for (const layerId of [...new Set([
    ...filterHighlightFillLayerIds,
    ...filterHighlightLineLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', filterHighlightFlatVisibility);
  }
  for (const layerId of [...new Set([
    ...partFilterHighlightExtrusionLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', partHighlightExtrusionVisibility);
  }
  for (const layerId of [...new Set([
    ...partFilterHighlightFillLayerIds,
    ...partFilterHighlightLineLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', partHighlightFlatVisibility);
  }
  for (const layerId of [...new Set([
    ...hoverExtrusionLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', hoverExtrusionVisibility);
  }
  for (const layerId of [...new Set([
    ...hoverFillLayerIds,
    ...hoverLineLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', hoverFlatVisibility);
  }
  for (const layerId of [...new Set([
    ...selectedExtrusionLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', selectedExtrusionVisibility);
  }
  for (const layerId of [...new Set([
    ...selectedFillLayerIds,
    ...selectedLineLayerIds
  ])]) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', selectedFlatVisibility);
  }
}
