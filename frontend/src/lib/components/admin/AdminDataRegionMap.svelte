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
  const REGIONS_FILL_LAYER_ID = 'admin-data-regions-fill';
  const REGIONS_LINE_LAYER_ID = 'admin-data-regions-line';
  const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };
  const DEFAULT_FEATURE_TONE = 'missing';

  let mapEl;
  let map = null;
  let maplibregl = null;
  let mapRuntimePromise = null;
  let mapInitNonce = 0;
  let sourceGeoJson = EMPTY_FEATURE_COLLECTION;
  let mapLoading = true;
  let mapError = '';
  let hasInitialFit = false;
  let lastFocusedDraftKey = '';
  let mapBootstrapRequested = false;
  let regionById = new Map();
  let featureById = new Map();
  let featureIdsBySlug = new Map();
  let featureIdsByExtractKey = new Map();
  let toneStateByFeatureId = new Map();
  let selectedFeatureIds = [];

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

  function normalizeLookupKey(value) {
    return String(value || '').trim().toLowerCase();
  }

  function buildExtractLookupKey(extractSource, extractId) {
    const normalizedExtractId = normalizeLookupKey(extractId);
    if (!normalizedExtractId) return '';
    return `${normalizeLookupKey(extractSource) || 'osmfr'}:${normalizedExtractId}`;
  }

  function addFeatureIdToLookup(mapRef, key, featureId) {
    if (!key) return;
    const current = mapRef.get(key);
    if (current) {
      current.push(featureId);
      return;
    }
    mapRef.set(key, [featureId]);
  }

  function buildFeatureId(index) {
    return index + 1;
  }

  function createNormalizedGeoJson(data) {
    const features = Array.isArray(data?.features) ? data.features : [];
    const nextFeatureById = new Map();
    const nextFeatureIdsBySlug = new Map();
    const nextFeatureIdsByExtractKey = new Map();

    const normalizedFeatures = features.map((feature, index) => {
      const meta = controller?.getMapRegionFeatureMeta?.(feature) || {};
      const featureId = buildFeatureId(index);
      const normalizedFeature = {
        ...feature,
        id: featureId
      };

      nextFeatureById.set(featureId, normalizedFeature);
      addFeatureIdToLookup(nextFeatureIdsBySlug, normalizeLookupKey(meta.slug), featureId);
      addFeatureIdToLookup(
        nextFeatureIdsByExtractKey,
        buildExtractLookupKey(meta.extractSource, meta.extractId),
        featureId
      );

      return normalizedFeature;
    });

    return {
      collection: {
        type: 'FeatureCollection',
        features: normalizedFeatures
      },
      featureById: nextFeatureById,
      featureIdsBySlug: nextFeatureIdsBySlug,
      featureIdsByExtractKey: nextFeatureIdsByExtractKey
    };
  }

  function buildRegionIdLookup(currentRegions) {
    const lookup = new Map();
    for (const region of Array.isArray(currentRegions) ? currentRegions : []) {
      const numericRegionId = Number(region?.id || 0);
      if (!Number.isInteger(numericRegionId) || numericRegionId <= 0) continue;
      lookup.set(numericRegionId, region);
    }
    return lookup;
  }

  function getMapTone(region) {
    const state = controller?.getRegionSyncState?.(region);
    if (state === 'syncing') return 'syncing';
    if (state === 'ready') return 'ready';
    return 'missing';
  }

  function resolveFeatureIdsByDraft(currentDraft) {
    const draftSlug = String(currentDraft?.slug || '').trim().toLowerCase();
    const draftExtractSource = String(currentDraft?.extractSource || '').trim().toLowerCase();
    const draftExtractId = String(currentDraft?.extractId || '').trim().toLowerCase();
    const resolvedIds = new Set();

    if (draftSlug) {
      for (const featureId of featureIdsBySlug.get(draftSlug) || []) {
        resolvedIds.add(featureId);
      }
    }

    if (draftExtractId) {
      const exactIds = featureIdsByExtractKey.get(buildExtractLookupKey(draftExtractSource, draftExtractId)) || [];
      if (exactIds.length > 0) {
        for (const featureId of exactIds) {
          resolvedIds.add(featureId);
        }
      } else if (!draftExtractSource) {
        for (const [extractKey, featureIds] of featureIdsByExtractKey.entries()) {
          if (!extractKey.endsWith(`:${draftExtractId}`)) continue;
          for (const featureId of featureIds) {
            resolvedIds.add(featureId);
          }
        }
      }
    }

    return [...resolvedIds];
  }

  function resolveFeatureIdsByRegion(region) {
    const nextRegion = region && typeof region === 'object' ? region : {};
    const resolvedIds = new Set();
    const slug = normalizeLookupKey(nextRegion.slug);
    const extractKey = buildExtractLookupKey(nextRegion.extractSource, nextRegion.extractId);

    if (slug) {
      for (const featureId of featureIdsBySlug.get(slug) || []) {
        resolvedIds.add(featureId);
      }
    }

    if (extractKey) {
      for (const featureId of featureIdsByExtractKey.get(extractKey) || []) {
        resolvedIds.add(featureId);
      }
    }

    return [...resolvedIds];
  }

  function resolveSelectedFeatureIds(currentDraft, currentSelectedRegionId) {
    const resolvedIds = new Set(resolveFeatureIdsByDraft(currentDraft));
    const numericSelectedRegionId = Number(currentSelectedRegionId || 0);
    const selectedRegion = Number.isInteger(numericSelectedRegionId) && numericSelectedRegionId > 0
      ? regionById.get(numericSelectedRegionId) || null
      : null;

    for (const featureId of resolveFeatureIdsByRegion(selectedRegion)) {
      resolvedIds.add(featureId);
    }

    return [...resolvedIds];
  }

  function getSelectedFeature() {
    for (const featureId of selectedFeatureIds) {
      const selectedFeature = featureById.get(featureId);
      if (selectedFeature) return selectedFeature;
    }
    return null;
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

  function getFeatureStateTarget(featureId) {
    return {
      source: REGIONS_SOURCE_ID,
      id: featureId
    };
  }

  function resetTrackedFeatureStates() {
    toneStateByFeatureId = new Map();
    selectedFeatureIds = [];
  }

  function syncMapSource(collection = sourceGeoJson, options = {}) {
    if (!map?.getSource(REGIONS_SOURCE_ID)) return;
    if (options.resetFeatureState) {
      resetTrackedFeatureStates();
    }
    map.getSource(REGIONS_SOURCE_ID).setData(collection);
  }

  function syncRegionFeatureToneStates(currentRegions = regions) {
    if (!map?.getSource(REGIONS_SOURCE_ID)) return;

    const nextToneStateByFeatureId = new Map();
    for (const feature of Array.isArray(sourceGeoJson?.features) ? sourceGeoJson.features : []) {
      const featureId = feature?.id;
      if (featureId == null) continue;

      const matchedRegion = controller?.findRegionByMapFeature?.(feature, currentRegions) || null;
      nextToneStateByFeatureId.set(featureId, matchedRegion ? getMapTone(matchedRegion) : DEFAULT_FEATURE_TONE);
    }

    for (const [featureId, previousTone] of toneStateByFeatureId.entries()) {
      const nextTone = nextToneStateByFeatureId.get(featureId);
      if (nextTone === previousTone) continue;
      map.removeFeatureState(getFeatureStateTarget(featureId), 'tone');
    }

    for (const [featureId, tone] of nextToneStateByFeatureId.entries()) {
      if (toneStateByFeatureId.get(featureId) === tone) continue;
      map.setFeatureState(getFeatureStateTarget(featureId), {
        tone
      });
    }

    toneStateByFeatureId = nextToneStateByFeatureId;
  }

  function syncSelectedFeatureStates(currentDraft = draft, currentSelectedRegionId = selectedRegionId) {
    if (!map?.getSource(REGIONS_SOURCE_ID)) return;

    const nextSelectedFeatureIds = resolveSelectedFeatureIds(currentDraft, currentSelectedRegionId);
    const previousSelectedIds = new Set(selectedFeatureIds);
    const nextSelectedIds = new Set(nextSelectedFeatureIds);

    for (const featureId of selectedFeatureIds) {
      if (nextSelectedIds.has(featureId)) continue;
      map.removeFeatureState(getFeatureStateTarget(featureId), 'selected');
    }

    for (const featureId of nextSelectedFeatureIds) {
      if (previousSelectedIds.has(featureId)) continue;
      map.setFeatureState(getFeatureStateTarget(featureId), {
        selected: true
      });
    }

    selectedFeatureIds = nextSelectedFeatureIds;
  }

  function ensureRegionLayers() {
    if (!map) return;

    if (!map.getSource(REGIONS_SOURCE_ID)) {
      map.addSource(REGIONS_SOURCE_ID, {
        type: 'geojson',
        data: sourceGeoJson
      });
      resetTrackedFeatureStates();
    }

    if (!map.getLayer(REGIONS_FILL_LAYER_ID)) {
      map.addLayer({
        id: REGIONS_FILL_LAYER_ID,
        type: 'fill',
        source: REGIONS_SOURCE_ID,
        paint: {
          'fill-color': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            [
              'match',
              ['feature-state', 'tone'],
              'ready',
              '#3F9E57',
              'syncing',
              '#E7A928',
              '#8BA6E8'
            ],
            [
              'match',
              ['feature-state', 'tone'],
              'ready',
              '#5DAE6D',
              'syncing',
              '#F1C84A',
              '#D4D7DD'
            ]
          ],
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            0.8,
            ['==', ['feature-state', 'tone'], 'ready'],
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
            ['boolean', ['feature-state', 'selected'], false],
            [
              'match',
              ['feature-state', 'tone'],
              'ready',
              '#14532D',
              'syncing',
              '#92400E',
              '#1D4ED8'
            ],
            ['==', ['feature-state', 'tone'], 'ready'],
            '#2F6B3C',
            ['==', ['feature-state', 'tone'], 'syncing'],
            '#9A6700',
            '#768195'
          ],
          'line-opacity': 0.96,
          'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 4.6, 1.4]
        }
      });
    }

    syncMapSource(sourceGeoJson, { resetFeatureState: true });
    syncRegionFeatureToneStates(regions);
    syncSelectedFeatureStates(draft, selectedRegionId);
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
      const normalized = createNormalizedGeoJson(data);
      sourceGeoJson = normalized.collection;
      featureById = normalized.featureById;
      featureIdsBySlug = normalized.featureIdsBySlug;
      featureIdsByExtractKey = normalized.featureIdsByExtractKey;
      hasInitialFit = false;
    } catch (error) {
      sourceGeoJson = EMPTY_FEATURE_COLLECTION;
      featureById = new Map();
      featureIdsBySlug = new Map();
      featureIdsByExtractKey = new Map();
      resetTrackedFeatureStates();
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
    resetTrackedFeatureStates();
  }

  $: regionById = buildRegionIdLookup(regions);

  $: if (map?.getSource(REGIONS_SOURCE_ID)) {
    sourceGeoJson;
    syncMapSource(sourceGeoJson, { resetFeatureState: true });
  }

  $: if (map?.getSource(REGIONS_SOURCE_ID)) {
    sourceGeoJson;
    syncRegionFeatureToneStates(regions);
  }

  $: if (map?.getSource(REGIONS_SOURCE_ID)) {
    sourceGeoJson;
    regionById;
    syncSelectedFeatureStates(draft, selectedRegionId);
  }

  $: if (map && !hasInitialFit && sourceGeoJson.features.length > 0) {
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
