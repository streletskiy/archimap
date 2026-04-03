import { resolvePmtilesUrl } from '../map-runtime.js';
import { buildRegionLayerId, buildRegionSourceId } from '../region-pmtiles.js';
import { getBuildingHoverThemePaint, getBuildingThemePaint } from './map-theme-utils.js';
import {
  BUILDING_PART_FEATURE_KIND,
  OVERPASS_BUILDING_SOURCE_ID,
  buildRegionBuildingLayerFilterExpression
} from './map-layer-utils.js';
import {
  buildBuildingExtrusionBaseExpression,
  buildBuildingExtrusionHeightExpression
} from './map-3d-utils.js';
import { EMPTY_LAYER_FILTER } from '../../components/map/filter-highlight-utils.js';

export const BUILDING_RENDERER_KIND = 'maplibre-extrusion';

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

function buildOverpassBuildingLayerId(suffix = '') {
  const normalizedSuffix = String(suffix || '').trim();
  return normalizedSuffix ? `${OVERPASS_BUILDING_SOURCE_ID}-${normalizedSuffix}` : OVERPASS_BUILDING_SOURCE_ID;
}

function ensureLayerVisibility(map, layerId, visibility) {
  if (!map?.getLayer?.(layerId)) return;
  map.setLayoutProperty(layerId, 'visibility', visibility);
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

export type BuildingRendererBackend = Readonly<{
  kind: typeof BUILDING_RENDERER_KIND;
  applyBuildingThemePaint: typeof applyBuildingThemePaint;
  applyBuildingPartsLayerVisibility: typeof applyBuildingPartsLayerVisibility;
  ensureOverpassBuildingSourceAndLayers: typeof ensureOverpassBuildingSourceAndLayers;
  ensureRegionBuildingSourceAndLayers: typeof ensureRegionBuildingSourceAndLayers;
  removeRegionBuildingSourceAndLayers: typeof removeRegionBuildingSourceAndLayers;
}>;

const buildingRenderer = Object.freeze({
  kind: BUILDING_RENDERER_KIND,
  applyBuildingThemePaint,
  applyBuildingPartsLayerVisibility,
  ensureOverpassBuildingSourceAndLayers,
  ensureRegionBuildingSourceAndLayers,
  removeRegionBuildingSourceAndLayers
}) as BuildingRendererBackend;

export function getMapLibreBuildingRenderer() {
  return buildingRenderer;
}
