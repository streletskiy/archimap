<script>
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';

  import { locale, t, translateNow } from '$lib/i18n/index';
  import { CUSTOM_MAP_ATTRIBUTION } from '$lib/constants/map';
  import { getRuntimeConfig } from '$lib/services/config';
  import { createMapStyleSyncController } from '$lib/services/map/map-style-sync';
  import { loadMapRuntime } from '$lib/services/map-runtime';
  import { focusMapOnGeometry } from '$lib/utils/map-geometry';

  export let controller;
  export let regions = [];
  export let draft = {};
  export let selectedRegionId = null;
  export let disabled = false;

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
  let lastFocusedDraftKey;
  let mapBootstrapRequested;
  let regionById = new Map();
  let featureById = new Map();
  let featureAreaById = new Map();
  let featureIdsBySlug = new Map();
  let featureIdsByExtractKey = new Map();
  let toneStateByFeatureId = new Map();
  let selectedFeatureIds = [];
  let hoveredFeatureId = null;
  let hoveredFeatureMeta = null;
  const mapStyleSync = createMapStyleSyncController({
    getMap: () => map,
    getTheme: () => (isDarkTheme() ? 'dark' : 'light'),
    getLocaleCode: () => get(locale),
    getRuntimeConfig
  });

  function ensureMapRuntime() {
    if (!mapRuntimePromise) {
      mapRuntimePromise = loadMapRuntime();
    }
    return mapRuntimePromise;
  }

  function isDarkTheme() {
    return String(document.documentElement?.getAttribute('data-theme') || '').toLowerCase() === 'dark';
  }

  function getRegionLineColors() {
    if (isDarkTheme()) {
      return {
        selected: {
          failed: '#FECACA',
          ready: '#BBF7D0',
          syncing: '#FDE68A',
          default: '#C7D2FE'
        },
        normal: {
          failed: '#FFE4E6',
          ready: '#DCFCE7',
          syncing: '#FEF3C7',
          default: '#E2E8F0'
        }
      };
    }

    return {
      selected: {
        failed: '#7F1D1D',
        ready: '#14532D',
        syncing: '#92400E',
        default: '#1D4ED8'
      },
      normal: {
        failed: '#B91C1C',
        ready: '#2F6B3C',
        syncing: '#9A6700',
        default: '#768195'
      }
    };
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

  function signedRingArea(ring = []) {
    if (!Array.isArray(ring) || ring.length < 3) return 0;
    let sum = 0;
    for (let index = 0; index < ring.length; index += 1) {
      const current = ring[index];
      const next = ring[(index + 1) % ring.length];
      const x1 = Number(current?.[0]);
      const y1 = Number(current?.[1]);
      const x2 = Number(next?.[0]);
      const y2 = Number(next?.[1]);
      if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
      sum += (x1 * y2) - (x2 * y1);
    }
    return sum / 2;
  }

  function polygonAreaFromCoordinates(coordinates = []) {
    if (!Array.isArray(coordinates) || coordinates.length === 0) return 0;
    const [outerRing, ...holeRings] = coordinates;
    const outerArea = Math.abs(signedRingArea(outerRing));
    const holeArea = holeRings.reduce((total, ring) => total + Math.abs(signedRingArea(ring)), 0);
    return Math.max(0, outerArea - holeArea);
  }

  function geometryArea(geometry = null) {
    const type = String(geometry?.type || '');
    const coordinates = geometry?.coordinates;
    if (type === 'Polygon') {
      return polygonAreaFromCoordinates(coordinates);
    }
    if (type === 'MultiPolygon' && Array.isArray(coordinates)) {
      return coordinates.reduce((total, polygonCoordinates) => total + polygonAreaFromCoordinates(polygonCoordinates), 0);
    }
    return 0;
  }

  function getFeatureInteractiveArea(feature = null) {
    const featureId = Number(feature?.id || 0);
    if (Number.isInteger(featureId) && featureId > 0) {
      const cachedArea = Number(featureAreaById.get(featureId) || 0);
      if (Number.isFinite(cachedArea) && cachedArea > 0) {
        return cachedArea;
      }
    }
    return geometryArea(feature?.geometry);
  }

  function sortFeaturesByInteractivePriority(features = []) {
    return [...(Array.isArray(features) ? features : [])]
      .filter(Boolean)
      .sort((left, right) => {
        const leftArea = getFeatureInteractiveArea(left);
        const rightArea = getFeatureInteractiveArea(right);
        if (leftArea !== rightArea) return leftArea - rightArea;
        return Number(left?.id || 0) - Number(right?.id || 0);
      });
  }

  function getInteractiveFeatureAtPoint(point = null) {
    if (!map || !point) return null;
    const renderedFeatures = map.queryRenderedFeatures(point, {
      layers: [REGIONS_FILL_LAYER_ID]
    });
    return sortFeaturesByInteractivePriority(renderedFeatures)[0] || null;
  }

  function createNormalizedGeoJson(data) {
    const features = Array.isArray(data?.features) ? data.features : [];
    const nextFeatureById = new Map();
    const nextFeatureAreaById = new Map();
    const nextFeatureIdsBySlug = new Map();
    const nextFeatureIdsByExtractKey = new Map();

    const normalizedFeatures = [...features]
      .sort((left, right) => {
        const leftArea = geometryArea(left?.geometry);
        const rightArea = geometryArea(right?.geometry);
        if (leftArea !== rightArea) return rightArea - leftArea;
        return String(left?.properties?.ExtractId || '').localeCompare(String(right?.properties?.ExtractId || ''));
      })
      .map((feature, index) => {
      const meta = controller?.getMapRegionFeatureMeta?.(feature) || {};
      const featureId = buildFeatureId(index);
      const featureArea = geometryArea(feature?.geometry);
      const normalizedFeature = {
        ...feature,
        id: featureId
      };

        nextFeatureById.set(featureId, normalizedFeature);
        nextFeatureAreaById.set(featureId, featureArea);
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
      featureAreaById: nextFeatureAreaById,
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
    if (state === 'failed') return 'failed';
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

  function clearHoveredFeatureState() {
    if (map?.getSource(REGIONS_SOURCE_ID) && Number.isInteger(hoveredFeatureId) && hoveredFeatureId > 0) {
      map.removeFeatureState(getFeatureStateTarget(hoveredFeatureId), 'hovered');
    }
    hoveredFeatureId = null;
    hoveredFeatureMeta = null;
  }

  function syncHoveredFeatureState(feature = null) {
    if (!map?.getSource(REGIONS_SOURCE_ID)) return;

    const nextFeatureId = Number(feature?.id || 0);
    if (!Number.isInteger(nextFeatureId) || nextFeatureId <= 0) {
      clearHoveredFeatureState();
      return;
    }

    if (hoveredFeatureId === nextFeatureId) {
      hoveredFeatureMeta = controller?.getMapRegionFeatureMeta?.(feature) || hoveredFeatureMeta;
      return;
    }

    clearHoveredFeatureState();
    map.setFeatureState(getFeatureStateTarget(nextFeatureId), {
      hovered: true
    });
    hoveredFeatureId = nextFeatureId;
    hoveredFeatureMeta = controller?.getMapRegionFeatureMeta?.(feature) || null;
  }

  function resetTrackedFeatureStates() {
    toneStateByFeatureId = new Map();
    selectedFeatureIds = [];
    featureAreaById = new Map();
    hoveredFeatureId = null;
    hoveredFeatureMeta = null;
  }

  function syncMapSource(collection = sourceGeoJson, options = {}) {
    if (!map?.getSource(REGIONS_SOURCE_ID)) return;
    if (options.resetFeatureState) {
      clearHoveredFeatureState();
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
    const lineColors = getRegionLineColors();

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
              'failed',
              '#DC2626',
              'ready',
              '#3F9E57',
              'syncing',
              '#E7A928',
              '#8BA6E8'
            ],
            [
              'match',
              ['feature-state', 'tone'],
              'failed',
              '#FCA5A5',
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
            0.82,
            ['boolean', ['feature-state', 'hovered'], false],
            0.68,
            ['==', ['feature-state', 'tone'], 'failed'],
            0.54,
            ['==', ['feature-state', 'tone'], 'ready'],
            0.56,
            0.46
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
              'failed',
              lineColors.selected.failed,
              'ready',
              lineColors.selected.ready,
              'syncing',
              lineColors.selected.syncing,
              lineColors.selected.default
            ],
            ['==', ['feature-state', 'tone'], 'failed'],
            lineColors.normal.failed,
            ['==', ['feature-state', 'tone'], 'ready'],
            lineColors.normal.ready,
            ['==', ['feature-state', 'tone'], 'syncing'],
            lineColors.normal.syncing,
            lineColors.normal.default
          ],
          'line-opacity': 0.98,
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            4.6,
            ['boolean', ['feature-state', 'hovered'], false],
            3,
            1.8
          ]
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
      featureAreaById = normalized.featureAreaById;
      featureIdsBySlug = normalized.featureIdsBySlug;
      featureIdsByExtractKey = normalized.featureIdsByExtractKey;
      hasInitialFit = false;
    } catch (error) {
      sourceGeoJson = EMPTY_FEATURE_COLLECTION;
      featureById = new Map();
      featureAreaById = new Map();
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

    const feature = getInteractiveFeatureAtPoint(event?.point) || event?.features?.[0] || null;
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
    const initialStyle = await mapStyleSync.resolveInitialStyle(config);
    if (map || !mapEl || initNonce !== mapInitNonce) return;
    map = new maplibregl.Map({
      container: mapEl,
      style: initialStyle,
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
    map.on('mousemove', REGIONS_FILL_LAYER_ID, (event) => {
      if (disabled) {
        clearHoveredFeatureState();
        return;
      }
      syncHoveredFeatureState(getInteractiveFeatureAtPoint(event?.point) || event?.features?.[0] || null);
    });
    map.on('mouseleave', REGIONS_FILL_LAYER_ID, () => {
      map.getCanvas().style.cursor = '';
      clearHoveredFeatureState();
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
    void lastFocusedDraftKey;
  }

  $: if (mapEl && !mapBootstrapRequested) {
    mapBootstrapRequested = true;
    void Promise.all([loadRegionsGeoJson(), ensureMap()]);
  }
  $: void mapBootstrapRequested;

  onMount(() => {
    const observer = new MutationObserver(() => {
      void mapStyleSync.syncMapStyle();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
    const unsubscribeLocale = locale.subscribe(() => {
      void mapStyleSync.syncMapStyle();
    });

    return () => {
      unsubscribeLocale();
      observer.disconnect();
      mapStyleSync.reset();
      destroyMap();
    };
  });
</script>

<section class="data-map-card rounded-2xl p-4 min-w-0">
  <div class="space-y-1">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h4 class="text-base font-bold ui-text-strong">{$t('admin.data.map.title')}</h4>
      <div class="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold sm:justify-end">
        <span class="data-map-legend rounded-full px-2 py-0.5" data-tone="missing">{$t('admin.data.map.legendMissing')}</span>
        <span class="data-map-legend rounded-full px-2 py-0.5" data-tone="syncing">{$t('admin.data.map.legendSyncing')}</span>
        <span class="data-map-legend rounded-full px-2 py-0.5" data-tone="failed">{$t('admin.data.map.legendFailed')}</span>
        <span class="data-map-legend rounded-full px-2 py-0.5" data-tone="ready">{$t('admin.data.map.legendReady')}</span>
      </div>
    </div>
    <p class="text-sm ui-text-muted">{$t('admin.data.map.description')}</p>
  </div>

  {#if mapError}
    <p class="mt-3 text-sm ui-text-danger">{mapError}</p>
  {:else if mapLoading}
    <p class="mt-3 text-sm ui-text-muted">{$t('admin.data.map.loading')}</p>
  {/if}

  <div class="relative mt-4 overflow-hidden rounded-2xl border ui-border">
    {#if hoveredFeatureMeta?.name || hoveredFeatureMeta?.extractId}
      <div class="pointer-events-none absolute left-3 top-3 z-10 max-w-[calc(100%-1.5rem)] rounded-xl border ui-border ui-surface-soft px-3 py-2 shadow-sm">
        <p class="truncate text-sm font-semibold ui-text-strong">{hoveredFeatureMeta.name || hoveredFeatureMeta.extractId}</p>
      </div>
    {/if}
    <div class="data-map-canvas h-[28rem] min-h-[420px] w-full" bind:this={mapEl}></div>
  </div>

  <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
    {#if !draft?.name}
      <p class="ui-text-subtle">{$t('admin.data.map.selectionHint')}</p>
    {/if}
    {#if draft?.extractSource && draft?.extractId}
      <span class="rounded-full ui-surface-soft px-2.5 py-1 ui-text-muted">{draft.extractSource} · {draft.extractId}</span>
    {/if}
  </div>
</section>

<style>
  .data-map-card {
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
    box-shadow: var(--shadow-soft);
  }

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

  .data-map-legend[data-tone='failed'] {
    background: #fee2e2;
    color: #b91c1c;
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

  :global(html[data-theme='dark']) .data-map-legend[data-tone='failed'] {
    background: #4c1212;
    color: #fca5a5;
  }

  :global(html[data-theme='dark']) .data-map-legend[data-tone='ready'] {
    background: #064e3b;
    color: #86efac;
  }
</style>
