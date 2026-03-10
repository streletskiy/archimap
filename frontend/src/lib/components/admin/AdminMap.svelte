<script>
  import { createEventDispatcher, onMount } from 'svelte';

  import { CUSTOM_MAP_ATTRIBUTION } from '$lib/constants/map';
  import { getRuntimeConfig } from '$lib/services/config';
  import { loadMapRuntime, resolvePmtilesUrl } from '$lib/services/map-runtime';
  import { buildRegionLayerId, buildRegionSourceId } from '$lib/services/region-pmtiles';
  import { getEditKey, parseEditKey } from '$lib/utils/edit-ui';
  import { focusMapOnGeometry } from '$lib/utils/map-geometry';

  export let visibleEdits = [];
  export let centerByKey = new Map();
  export let editIdByKey = new Map();
  export let selectedFeature = { type: 'FeatureCollection', features: [] };

  const LIGHT = '/styles/positron-custom.json';
  const DARK = '/styles/dark-matter-custom.json';
  const SRC = 'edited-points';
  const L_CLUSTER = 'edited-points-clusters';
  const L_COUNT = 'edited-points-cluster-count';
  const L_POINT = 'edited-points-unclustered';
  const MAP_PIN_COLOR = '#FDC82F';
  const MAP_PIN_INK = '#342700';
  const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };

  const dispatch = createEventDispatcher();

  let mapEl;
  let map = null;
  let maplibregl = null;
  let mapRuntimePromise = null;
  let protocol = null;
  let mapInitNonce = 0;
  let activeRegionPmtiles = [];

  function ensureMapRuntime() {
    if (!mapRuntimePromise) {
      mapRuntimePromise = loadMapRuntime();
    }
    return mapRuntimePromise;
  }

  function styleByTheme() {
    return String(document.documentElement?.getAttribute('data-theme') || '').toLowerCase() === 'dark' ? DARK : LIGHT;
  }

  function getEditedFillLayerIds() {
    return activeRegionPmtiles.length > 0
      ? activeRegionPmtiles.map((region) => buildRegionLayerId(region.id, 'edited-fill'))
      : ['edited-fill'];
  }

  function getEditedLineLayerIds() {
    return activeRegionPmtiles.length > 0
      ? activeRegionPmtiles.map((region) => buildRegionLayerId(region.id, 'edited-line'))
      : ['edited-line'];
  }

  function ensureAdminBuildingLayers(config) {
    if (!map) return;

    const regions = Array.isArray(config?.buildingRegionsPmtiles) ? config.buildingRegionsPmtiles : [];
    activeRegionPmtiles = regions;

    if (!map.getSource('selected-building')) {
      map.addSource('selected-building', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
    }
    if (!map.getSource(SRC)) {
      map.addSource(SRC, {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
        cluster: true,
        clusterRadius: 44,
        clusterMaxZoom: 12
      });
    }

    if (map.getLayer('edited-fill')) map.removeLayer('edited-fill');
    if (map.getLayer('edited-line')) map.removeLayer('edited-line');
    if (map.getSource('local-buildings')) map.removeSource('local-buildings');

    for (const region of regions) {
      const sourceId = buildRegionSourceId(region.id);
      const fillLayerId = buildRegionLayerId(region.id, 'edited-fill');
      const lineLayerId = buildRegionLayerId(region.id, 'edited-line');
      const sourceUrl = resolvePmtilesUrl(region.url, window.location.origin);

      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, { type: 'vector', url: `pmtiles://${sourceUrl}` });
      }
      if (!map.getLayer(fillLayerId)) {
        map.addLayer({
          id: fillLayerId,
          type: 'fill',
          source: sourceId,
          'source-layer': region.sourceLayer,
          minzoom: 13,
          paint: { 'fill-color': '#4F4A43', 'fill-opacity': 0.25 }
        });
      }
      if (!map.getLayer(lineLayerId)) {
        map.addLayer({
          id: lineLayerId,
          type: 'line',
          source: sourceId,
          'source-layer': region.sourceLayer,
          minzoom: 13,
          paint: { 'line-color': '#2B2824', 'line-width': 2 }
        });
      }
    }

    if (!map.getLayer('selected-fill')) {
      map.addLayer({
        id: 'selected-fill',
        type: 'fill',
        source: 'selected-building',
        paint: { 'fill-color': '#4F4A43', 'fill-opacity': 0.2 }
      });
    }
    if (!map.getLayer('selected-line')) {
      map.addLayer({
        id: 'selected-line',
        type: 'line',
        source: 'selected-building',
        paint: { 'line-color': '#2B2824', 'line-width': 3 }
      });
    }
    if (!map.getLayer(L_CLUSTER)) {
      map.addLayer({
        id: L_CLUSTER,
        type: 'circle',
        source: SRC,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': MAP_PIN_COLOR,
          'circle-radius': ['step', ['get', 'point_count'], 14, 20, 18, 80, 23],
          'circle-stroke-width': 2,
          'circle-stroke-color': MAP_PIN_INK
        }
      });
    }
    if (!map.getLayer(L_COUNT)) {
      map.addLayer({
        id: L_COUNT,
        type: 'symbol',
        source: SRC,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-size': 12,
          'text-font': ['Open Sans Bold']
        },
        paint: { 'text-color': MAP_PIN_INK }
      });
    }
    if (!map.getLayer(L_POINT)) {
      map.addLayer({
        id: L_POINT,
        type: 'circle',
        source: SRC,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': MAP_PIN_COLOR,
          'circle-radius': 7,
          'circle-stroke-width': 2,
          'circle-stroke-color': MAP_PIN_INK
        }
      });
    }
  }

  function fitAllEdited() {
    if (!map || !maplibregl?.LngLatBounds) return;

    const bounds = new maplibregl.LngLatBounds();
    let count = 0;
    for (const key of editIdByKey.keys()) {
      const center = centerByKey.get(key);
      if (!center) continue;
      bounds.extend(center);
      count += 1;
    }
    if (count > 0 && !bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 60, duration: 450, maxZoom: 17 });
    }
  }

  function applySelectedFeature(options = {}) {
    const { focus = false } = options;
    if (!map || !map.getSource('selected-building')) return;

    const feature = selectedFeature && typeof selectedFeature === 'object' ? selectedFeature : EMPTY_FEATURE_COLLECTION;
    map.getSource('selected-building').setData(feature);
    if (focus) {
      const geometry =
        feature?.geometry || (Array.isArray(feature?.features) && feature.features.length > 0 ? feature.features[0]?.geometry : null);
      focusMapOnGeometry(map, maplibregl, geometry);
    }
  }

  function applyMapData() {
    if (!map || !map.getSource(SRC)) return;

    const features = [];
    const ids = [];
    for (const item of visibleEdits) {
      const key = getEditKey(item);
      if (!key) continue;
      const center = centerByKey.get(key);
      if (center) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: center },
          properties: { osmKey: key, editId: Number(item.id || item.editId || 0) }
        });
      }
      const parsed = parseEditKey(key);
      if (parsed) {
        ids.push(parsed.osmId * 2 + (parsed.osmType === 'relation' ? 1 : 0));
      }
    }

    map.getSource(SRC).setData({ type: 'FeatureCollection', features });
    for (const layerId of getEditedFillLayerIds()) {
      if (map.getLayer(layerId)) {
        map.setFilter(layerId, ['in', ['id'], ['literal', ids]]);
      }
    }
    for (const layerId of getEditedLineLayerIds()) {
      if (map.getLayer(layerId)) {
        map.setFilter(layerId, ['in', ['id'], ['literal', ids]]);
      }
    }
  }

  async function ensureMap() {
    if (map || !mapEl) return;

    const initNonce = ++mapInitNonce;
    const runtime = await ensureMapRuntime();
    if (!runtime?.maplibregl || map || !mapEl || initNonce !== mapInitNonce) return;

    const { maplibregl: mapRuntime, Protocol: ProtocolCtor } = runtime;
    maplibregl = mapRuntime;

    if (!protocol) {
      protocol = new ProtocolCtor();
      maplibregl.addProtocol('pmtiles', protocol.tile);
    }

    const config = getRuntimeConfig();
    map = new maplibregl.Map({
      container: mapEl,
      style: styleByTheme(),
      center: [config.mapDefault.lon, config.mapDefault.lat],
      zoom: Math.max(12, Number(config.mapDefault.zoom || 14)),
      attributionControl: false
    });
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: CUSTOM_MAP_ATTRIBUTION
      })
    );
    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('style.load', () => {
      ensureAdminBuildingLayers(config);
      applyMapData();
      applySelectedFeature({ focus: true });
      fitAllEdited();
    });
    map.on('click', L_CLUSTER, (event) => {
      const feature = event?.features?.[0];
      const clusterId = Number(feature?.properties?.cluster_id);
      const source = map.getSource(SRC);
      if (!Number.isInteger(clusterId) || !source?.getClusterExpansionZoom) return;
      source.getClusterExpansionZoom(clusterId, (error, zoom) => {
        if (!error) {
          map.easeTo({ center: feature.geometry?.coordinates || map.getCenter(), zoom, duration: 300 });
        }
      });
    });
    map.on('click', L_POINT, (event) => {
      const editId = Number(event?.features?.[0]?.properties?.editId || 0);
      if (Number.isInteger(editId) && editId > 0) {
        dispatch('openedit', { editId });
      }
    });
    map.on('click', (event) => {
      const clusterFeatures = map.queryRenderedFeatures(event.point, { layers: [L_CLUSTER, L_POINT] });
      if (Array.isArray(clusterFeatures) && clusterFeatures.length > 0) return;

      const buildingFeatures = map.queryRenderedFeatures(event.point, { layers: getEditedFillLayerIds() });
      const value = Number(buildingFeatures?.[0]?.id);
      if (!Number.isInteger(value)) return;

      const key = `${value % 2 === 1 ? 'relation' : 'way'}/${Math.floor(value / 2)}`;
      const editId = Number(editIdByKey.get(key) || 0);
      if (editId > 0) {
        dispatch('openedit', { editId });
      }
    });
  }

  function destroyMap() {
    mapInitNonce += 1;
    if (!map) return;
    map.remove();
    map = null;
  }

  $: if (map) {
    applyMapData();
    fitAllEdited();
  }

  $: if (map && map.getSource('selected-building')) {
    const hasGeometry =
      Boolean(selectedFeature?.geometry)
      || (Array.isArray(selectedFeature?.features) && selectedFeature.features.some((feature) => feature?.geometry));
    applySelectedFeature({ focus: hasGeometry });
  }

  onMount(() => {
    void ensureMap();

    const observer = new MutationObserver(() => {
      if (map) {
        map.setStyle(styleByTheme());
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      observer.disconnect();
      destroyMap();
    };
  });
</script>

<div class="h-[36vh] min-h-[260px] overflow-hidden rounded-xl border ui-border" bind:this={mapEl}></div>
