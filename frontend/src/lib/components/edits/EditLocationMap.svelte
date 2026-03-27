<script>
  import { onMount } from 'svelte';

  import { CUSTOM_MAP_ATTRIBUTION } from '$lib/constants/map';
  import { getRuntimeConfig } from '$lib/services/config';
  import { loadMapRuntime } from '$lib/services/map-runtime';
  import { focusMapOnGeometry } from '$lib/utils/map-geometry';

  export let selectedFeature = null;
  export let loading = false;
  export let loadingText = '';

  const LIGHT = '/styles/positron-custom.json';
  const DARK = '/styles/dark-matter-custom.json';
  const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };

  let mapEl;
  let map = null;
  let maplibregl = null;
  let mapRuntimePromise = null;
  let mapInitNonce = 0;

  function ensureMapRuntime() {
    if (!mapRuntimePromise) {
      mapRuntimePromise = loadMapRuntime();
    }
    return mapRuntimePromise;
  }

  function styleByTheme() {
    return String(document.documentElement?.getAttribute('data-theme') || '').toLowerCase() === 'dark'
      ? DARK
      : LIGHT;
  }

  function normalizeFeatureData(feature) {
    if (feature?.type === 'FeatureCollection' && Array.isArray(feature.features)) {
      return feature;
    }
    if (feature?.type === 'Feature' || feature?.geometry) {
      return {
        type: 'FeatureCollection',
        features: [feature]
      };
    }
    return EMPTY_FEATURE_COLLECTION;
  }

  function getPrimaryGeometry(featureData) {
    if (featureData?.type === 'FeatureCollection') {
      return featureData.features.find((item) => item?.geometry)?.geometry || null;
    }
    return featureData?.geometry || null;
  }

  function ensureLayers() {
    if (!map) return;

    if (!map.getSource('edit-detail-building')) {
      map.addSource('edit-detail-building', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION
      });
    }

    if (!map.getLayer('edit-detail-building-fill')) {
      map.addLayer({
        id: 'edit-detail-building-fill',
        type: 'fill',
        source: 'edit-detail-building',
        paint: {
          'fill-color': '#FDC82F',
          'fill-opacity': 0.24
        }
      });
    }

    if (!map.getLayer('edit-detail-building-line')) {
      map.addLayer({
        id: 'edit-detail-building-line',
        type: 'line',
        source: 'edit-detail-building',
        paint: {
          'line-color': '#8A6B00',
          'line-width': 4
        }
      });
    }

    if (!map.getLayer('edit-detail-building-point')) {
      map.addLayer({
        id: 'edit-detail-building-point',
        type: 'circle',
        source: 'edit-detail-building',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 8,
          'circle-color': '#FDC82F',
          'circle-stroke-color': '#8A6B00',
          'circle-stroke-width': 3
        }
      });
    }
  }

  function applySelectedFeature(options = {}) {
    const { focus = false } = options;
    if (!map || !map.getSource('edit-detail-building')) return;

    const data = normalizeFeatureData(selectedFeature);
    map.getSource('edit-detail-building').setData(data);

    if (!focus) return;

    const geometry = getPrimaryGeometry(data);
    if (!geometry) return;

    focusMapOnGeometry(map, maplibregl, geometry, {
      padding: 56,
      maxZoom: 17,
      pointZoom: 16,
      duration: 320
    });
  }

  async function ensureMap() {
    if (map || !mapEl) return;

    const initNonce = ++mapInitNonce;
    const runtime = await ensureMapRuntime();
    if (!runtime?.maplibregl || map || !mapEl || initNonce !== mapInitNonce) return;

    maplibregl = runtime.maplibregl;
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
      ensureLayers();
      applySelectedFeature({ focus: true });
      map.resize();
    });
  }

  function destroyMap() {
    mapInitNonce += 1;
    if (!map) return;
    map.remove();
    map = null;
  }

  $: if (map && map.getSource('edit-detail-building')) {
    const data = normalizeFeatureData(selectedFeature);
    applySelectedFeature({
      focus: Boolean(getPrimaryGeometry(data))
    });
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

<div class="edit-location-map" bind:this={mapEl}></div>

{#if loading && loadingText}
  <div class="edit-location-map-overlay">
    <p>{loadingText}</p>
  </div>
{/if}

<style>
  .edit-location-map {
    width: 100%;
    height: 100%;
    min-height: 100%;
  }

  .edit-location-map-overlay {
    position: absolute;
    inset: auto 0 0 0;
    padding: 0.75rem 0.9rem;
    background: linear-gradient(180deg, transparent 0%, rgba(8, 17, 31, 0.75) 100%);
    color: #fff8de;
    font-size: 0.8rem;
    font-weight: 600;
    pointer-events: none;
  }

  .edit-location-map-overlay p {
    margin: 0;
  }
</style>
