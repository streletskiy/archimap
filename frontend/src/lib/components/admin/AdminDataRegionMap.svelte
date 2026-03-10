<script>
  import { onMount } from 'svelte';

  import { t, translateNow } from '$lib/i18n/index';
  import { CUSTOM_MAP_ATTRIBUTION } from '$lib/constants/map';
  import { getRuntimeConfig } from '$lib/services/config';
  import { loadMapRuntime } from '$lib/services/map-runtime';
  import { focusMapOnGeometry } from '$lib/utils/map-geometry';

  export let controller;
  export let regions = [];
  export let draft = {};
  export let selectedRegionId = null;
  export let disabled = false;

  const LIGHT = '/styles/positron-custom.json';
  const DARK = '/styles/dark-matter-custom.json';
  const REGIONS_SOURCE_ID = 'admin-data-regions-source';
  const SELECTED_SOURCE_ID = 'admin-data-regions-selected-source';
  const REGIONS_FILL_LAYER_ID = 'admin-data-regions-fill';
  const REGIONS_LINE_LAYER_ID = 'admin-data-regions-line';
  const SELECTED_FILL_LAYER_ID = 'admin-data-regions-selected-fill';
  const SELECTED_LINE_LAYER_ID = 'admin-data-regions-selected-line';
  const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };

  let mapEl;
  let map = null;
  let maplibregl = null;
  let mapRuntimePromise = null;
  let mapInitNonce = 0;
  let sourceGeoJson = EMPTY_FEATURE_COLLECTION;
  let decoratedGeoJson = EMPTY_FEATURE_COLLECTION;
  let selectedFeatureCollection = EMPTY_FEATURE_COLLECTION;
  let mapLoading = true;
  let mapError = '';
  let hasInitialFit = false;
  let lastFocusedDraftKey = '';
  let mapBootstrapRequested = false;

  function ensureMapRuntime() {
    if (!mapRuntimePromise) {
      mapRuntimePromise = loadMapRuntime();
    }
    return mapRuntimePromise;
  }

  function styleByTheme() {
    return String(document.documentElement?.getAttribute('data-theme') || '').toLowerCase() === 'dark' ? DARK : LIGHT;
  }

  function walkGeometryCoordinates(coordinates, visit) {
    if (!Array.isArray(coordinates)) return;
    if (coordinates.length >= 2 && typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
      visit(coordinates[0], coordinates[1]);
      return;
    }
    for (const item of coordinates) {
      walkGeometryCoordinates(item, visit);
    }
  }

  function buildDraftKey(currentDraft) {
    const slug = String(currentDraft?.slug || '').trim();
    const extractSource = String(currentDraft?.extractSource || '').trim();
    const extractId = String(currentDraft?.extractId || '').trim();
    if (!slug && !extractSource && !extractId) return '';
    return `${slug}:${extractSource}:${extractId}`;
  }

  function getMapTone(region) {
    const state = controller?.getRegionSyncState?.(region);
    if (state === 'syncing') return 'syncing';
    if (state === 'ready') return 'ready';
    return 'missing';
  }

  function featureMatchesDraft(feature, currentDraft) {
    const meta = controller?.getMapRegionFeatureMeta?.(feature);
    if (!meta) return false;

    const draftSlug = String(currentDraft?.slug || '').trim().toLowerCase();
    const draftExtractSource = String(currentDraft?.extractSource || '').trim().toLowerCase();
    const draftExtractId = String(currentDraft?.extractId || '').trim().toLowerCase();

    if (draftSlug && String(meta.slug || '').trim().toLowerCase() === draftSlug) return true;
    if (
      draftExtractId
      && String(meta.extractId || '').trim().toLowerCase() === draftExtractId
      && (
        !draftExtractSource
        || String(meta.extractSource || '').trim().toLowerCase() === draftExtractSource
      )
    ) {
      return true;
    }
    return false;
  }

  function featureMatchesSelection(feature, currentDraft, matchedRegion, currentSelectedRegionId) {
    const numericSelectedRegionId = Number(currentSelectedRegionId || 0);
    if (matchedRegion && Number(matchedRegion.id || 0) > 0 && Number(matchedRegion.id || 0) === numericSelectedRegionId) {
      return true;
    }
    return featureMatchesDraft(feature, currentDraft);
  }

  function buildDecoratedGeoJson(collection, currentRegions, currentDraft, currentSelectedRegionId) {
    const base = collection && typeof collection === 'object' ? collection : EMPTY_FEATURE_COLLECTION;
    const features = Array.isArray(base.features) ? base.features : [];

    return {
      ...base,
      type: 'FeatureCollection',
      features: features.map((feature) => {
        const matchedRegion = controller?.findRegionByMapFeature?.(feature, currentRegions) || null;
        return {
          ...feature,
          properties: {
            ...(feature?.properties && typeof feature.properties === 'object' ? feature.properties : {}),
            __mapTone: matchedRegion ? getMapTone(matchedRegion) : 'missing',
            __selected: featureMatchesSelection(feature, currentDraft, matchedRegion, currentSelectedRegionId)
          }
        };
      })
    };
  }

  function getSelectedFeature(collection = decoratedGeoJson) {
    const features = Array.isArray(collection?.features) ? collection.features : [];
    return features.find((feature) => Boolean(feature?.properties?.__selected)) || null;
  }

  function buildSelectedFeatureCollection(collection = decoratedGeoJson) {
    const selectedFeature = getSelectedFeature(collection);
    if (!selectedFeature) return EMPTY_FEATURE_COLLECTION;
    return {
      type: 'FeatureCollection',
      features: [selectedFeature]
    };
  }

  function fitAllFeatures() {
    if (!map || !maplibregl?.LngLatBounds || !Array.isArray(sourceGeoJson.features) || sourceGeoJson.features.length === 0) return;

    const bounds = new maplibregl.LngLatBounds();
    let hasPoints = false;
    for (const feature of sourceGeoJson.features) {
      walkGeometryCoordinates(feature?.geometry?.coordinates, (lng, lat) => {
        bounds.extend([lng, lat]);
        hasPoints = true;
      });
    }

    if (hasPoints && !bounds.isEmpty()) {
      map.fitBounds(bounds, {
        padding: 44,
        duration: 0,
        maxZoom: 5.5
      });
      hasInitialFit = true;
    }
  }

  function syncMapSource(collection = decoratedGeoJson) {
    if (!map?.getSource(REGIONS_SOURCE_ID)) return;
    map.getSource(REGIONS_SOURCE_ID).setData(collection);
  }

  function syncSelectedSource(collection = selectedFeatureCollection) {
    if (!map?.getSource(SELECTED_SOURCE_ID)) return;
    map.getSource(SELECTED_SOURCE_ID).setData(collection);
  }

  function ensureRegionLayers() {
    if (!map) return;

    if (!map.getSource(REGIONS_SOURCE_ID)) {
      map.addSource(REGIONS_SOURCE_ID, {
        type: 'geojson',
        data: decoratedGeoJson
      });
    }

    if (!map.getSource(SELECTED_SOURCE_ID)) {
      map.addSource(SELECTED_SOURCE_ID, {
        type: 'geojson',
        data: selectedFeatureCollection
      });
    }

    if (!map.getLayer(REGIONS_FILL_LAYER_ID)) {
      map.addLayer({
        id: REGIONS_FILL_LAYER_ID,
        type: 'fill',
        source: REGIONS_SOURCE_ID,
        paint: {
          'fill-color': [
            'case',
            ['boolean', ['get', '__selected'], false],
            [
              'match',
              ['get', '__mapTone'],
              'ready',
              '#3F9E57',
              'syncing',
              '#E7A928',
              '#8BA6E8'
            ],
            [
              'match',
              ['get', '__mapTone'],
              'ready',
              '#5DAE6D',
              'syncing',
              '#F1C84A',
              '#D4D7DD'
            ]
          ],
          'fill-opacity': [
            'case',
            ['boolean', ['get', '__selected'], false],
            0.8,
            ['==', ['get', '__mapTone'], 'ready'],
            0.52,
            0.38
          ]
        }
      });
    }

    if (!map.getLayer(REGIONS_LINE_LAYER_ID)) {
      map.addLayer({
        id: REGIONS_LINE_LAYER_ID,
        type: 'line',
        source: REGIONS_SOURCE_ID,
        paint: {
          'line-color': [
            'case',
            ['boolean', ['get', '__selected'], false],
            [
              'match',
              ['get', '__mapTone'],
              'ready',
              '#14532D',
              'syncing',
              '#92400E',
              '#1D4ED8'
            ],
            ['==', ['get', '__mapTone'], 'ready'],
            '#2F6B3C',
            ['==', ['get', '__mapTone'], 'syncing'],
            '#9A6700',
            '#768195'
          ],
          'line-opacity': 0.96,
          'line-width': ['case', ['boolean', ['get', '__selected'], false], 4.6, 1.4]
        }
      });
    }

    syncMapSource(decoratedGeoJson);
    if (!map.getLayer(SELECTED_FILL_LAYER_ID)) {
      map.addLayer({
        id: SELECTED_FILL_LAYER_ID,
        type: 'fill',
        source: SELECTED_SOURCE_ID,
        paint: {
          'fill-color': '#60A5FA',
          'fill-opacity': 0.2
        }
      });
    }

    if (!map.getLayer(SELECTED_LINE_LAYER_ID)) {
      map.addLayer({
        id: SELECTED_LINE_LAYER_ID,
        type: 'line',
        source: SELECTED_SOURCE_ID,
        paint: {
          'line-color': '#1D4ED8',
          'line-opacity': 1,
          'line-width': 5.5
        }
      });
    }

    syncSelectedSource(selectedFeatureCollection);
  }

  async function loadRegionsGeoJson() {
    mapLoading = true;
    mapError = '';

    try {
      const response = await fetch('/admin-regions.geojson', {
        headers: {
          Accept: 'application/geo+json, application/json'
        }
      });
      if (!response.ok) {
        throw new Error(`${translateNow('admin.data.map.loadFailed')} (${response.status})`);
      }

      const data = await response.json();
      sourceGeoJson = {
        type: 'FeatureCollection',
        features: Array.isArray(data?.features) ? data.features : []
      };
      hasInitialFit = false;
    } catch (error) {
      sourceGeoJson = EMPTY_FEATURE_COLLECTION;
      mapError = String(error?.message || translateNow('admin.data.map.loadFailed'));
    } finally {
      mapLoading = false;
    }
  }

  async function handleRegionClick(event) {
    if (disabled) return;

    const feature = event?.features?.[0];
    if (!feature) return;

    const matchedRegion = controller?.findRegionByMapFeature?.(feature, regions) || null;
    if (matchedRegion?.id && controller?.selectDataRegion) {
      await controller.selectDataRegion(matchedRegion);
    } else {
      if (!controller?.startNewRegionDraft) return;
      if (!controller.startNewRegionDraft()) return;
      if (!controller.applyRegionDraftFromMapFeature?.(feature)) return;
    }

    focusMapOnGeometry(map, maplibregl, feature.geometry, {
      padding: 72,
      maxZoom: 7
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
      zoom: Math.max(3, Number(config.mapDefault.zoom || 4)),
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
      ensureRegionLayers();
      if (!hasInitialFit) {
        fitAllFeatures();
      }
    });
    map.on('mouseenter', REGIONS_FILL_LAYER_ID, () => {
      map.getCanvas().style.cursor = disabled ? '' : 'pointer';
    });
    map.on('mouseleave', REGIONS_FILL_LAYER_ID, () => {
      map.getCanvas().style.cursor = '';
    });
    map.on('click', REGIONS_FILL_LAYER_ID, handleRegionClick);
  }

  function destroyMap() {
    mapInitNonce += 1;
    if (!map) return;
    map.remove();
    map = null;
  }

  $: decoratedGeoJson = buildDecoratedGeoJson(sourceGeoJson, regions, draft, selectedRegionId);
  $: selectedFeatureCollection = buildSelectedFeatureCollection(decoratedGeoJson);

  $: if (map?.getSource(REGIONS_SOURCE_ID) && decoratedGeoJson) {
    syncMapSource(decoratedGeoJson);
  }

  $: if (map?.getSource(SELECTED_SOURCE_ID) && selectedFeatureCollection) {
    syncSelectedSource(selectedFeatureCollection);
  }

  $: if (map && !hasInitialFit && decoratedGeoJson.features.length > 0) {
    fitAllFeatures();
  }

  $: {
    const nextDraftKey = buildDraftKey(draft);
    if (!nextDraftKey) {
      lastFocusedDraftKey = '';
    } else if (map && nextDraftKey !== lastFocusedDraftKey) {
      const selectedFeature = getSelectedFeature();
      if (selectedFeature) {
        focusMapOnGeometry(map, maplibregl, selectedFeature.geometry, {
          padding: 72,
          maxZoom: 7
        });
      }
      lastFocusedDraftKey = nextDraftKey;
    }
  }

  $: if (mapEl && !mapBootstrapRequested) {
    mapBootstrapRequested = true;
    void Promise.all([loadRegionsGeoJson(), ensureMap()]);
  }

  onMount(() => {
    const observer = new MutationObserver(() => {
      if (map) {
        map.setStyle(styleByTheme());
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });

    return () => {
      observer.disconnect();
      destroyMap();
    };
  });
</script>

<section class="data-map-card rounded-2xl p-4 min-w-0">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="space-y-1">
      <span class="inline-flex rounded-full ui-surface-brand px-2.5 py-1 text-xs font-semibold ui-text-brand">
        {$t('admin.data.map.badge')}
      </span>
      <h4 class="text-base font-bold ui-text-strong">{$t('admin.data.map.title')}</h4>
      <p class="text-sm ui-text-muted">{$t('admin.data.map.description')}</p>
    </div>
    <div class="flex flex-wrap gap-2 text-xs ui-text-body">
      <span class="data-map-legend rounded-full px-3 py-1.5" data-tone="missing">{$t('admin.data.map.legendMissing')}</span>
      <span class="data-map-legend rounded-full px-3 py-1.5" data-tone="syncing">{$t('admin.data.map.legendSyncing')}</span>
      <span class="data-map-legend rounded-full px-3 py-1.5" data-tone="ready">{$t('admin.data.map.legendReady')}</span>
    </div>
  </div>

  {#if mapError}
    <p class="mt-3 text-sm ui-text-danger">{mapError}</p>
  {:else if mapLoading}
    <p class="mt-3 text-sm ui-text-muted">{$t('admin.data.map.loading')}</p>
  {/if}

  <div class="mt-4 overflow-hidden rounded-2xl border ui-border">
    <div class="data-map-canvas h-[28rem] min-h-[420px] w-full" bind:this={mapEl}></div>
  </div>

  <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
    <p class="ui-text-subtle">
      {#if draft?.name}
        {$t('admin.data.map.selectionLabel', { name: draft.name })}
      {:else}
        {$t('admin.data.map.selectionHint')}
      {/if}
    </p>
    {#if draft?.extractSource && draft?.extractId}
      <span class="rounded-full ui-surface-soft px-2.5 py-1 ui-text-muted">{draft.extractSource} · {draft.extractId}</span>
    {/if}
  </div>
</section>

<style>
  @import './admin-tabs.css';

  .data-map-legend {
    border: 1px solid transparent;
    font-weight: 600;
  }

  .data-map-legend[data-tone='missing'] {
    background: #e5e7eb;
    color: #475569;
  }

  .data-map-legend[data-tone='syncing'] {
    background: #fef3c7;
    color: #92400e;
  }

  .data-map-legend[data-tone='ready'] {
    background: #dcfce7;
    color: #166534;
  }

  :global(html[data-theme='dark']) .data-map-legend[data-tone='missing'] {
    background: #243247;
    color: #cbd5e1;
  }

  :global(html[data-theme='dark']) .data-map-legend[data-tone='syncing'] {
    background: #3f2a05;
    color: #fcd34d;
  }

  :global(html[data-theme='dark']) .data-map-legend[data-tone='ready'] {
    background: #064e3b;
    color: #86efac;
  }
</style>
