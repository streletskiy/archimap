<script>
  import { onMount, tick } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { fade } from 'svelte/transition';
  import { CUSTOM_MAP_ATTRIBUTION } from '$lib/constants/map';
  import PortalFrame from '$lib/components/shell/PortalFrame.svelte';
  import { parseUrlState, patchUrlState } from '$lib/client/urlState';
  import { session } from '$lib/stores/auth';
  import { apiJson } from '$lib/services/http';
  import { getRuntimeConfig } from '$lib/services/config';
  import { loadMapRuntime, resolvePmtilesUrl } from '$lib/services/map-runtime';
  import { buildRegionLayerId, buildRegionSourceId } from '$lib/services/region-pmtiles';
  import { t, translateNow } from '$lib/i18n/index';
  import {
    formatUiDate,
    getChangeCounters,
    getEditAddress,
    getEditKey,
    getStatusBadgeMeta,
    parseEditKey
  } from '$lib/utils/edit-ui';
  import { focusMapOnGeometry, getGeometryCenter } from '$lib/utils/map-geometry';

  const LIGHT = '/styles/positron-custom.json';
  const DARK = '/styles/dark-matter-custom.json';
  const SRC = 'edited-points';
  const L_CLUSTER = 'edited-points-clusters';
  const L_COUNT = 'edited-points-cluster-count';
  const L_POINT = 'edited-points-unclustered';
  const MAP_PIN_COLOR = '#FDC82F';
  const MAP_PIN_INK = '#342700';
  const DATA_I18N_PREFIX = 'admin.data';

  let activeTab = 'edits';

  let users = [];
  let usersLoading = false;
  let usersStatus = translateNow('admin.loading');
  let usersQuery = '';
  let usersRole = 'all';
  let usersCanEdit = 'all';
  let usersHasEdits = 'all';
  let usersSortBy = 'createdAt';
  let usersSortDir = 'desc';

  let edits = [];
  let visibleEdits = [];
  let editsLoading = false;
  let editsStatus = translateNow('admin.loading');
  let editsFilter = 'all';
  let editsLimit = 200;
  let editsQuery = '';
  let editsDate = '';
  let editsUser = '';
  let editsUsers = [];

  let selectedEdit = null;
  let detailLoading = false;
  let detailStatus = '';
  let detailPaneVisible = false;
  let detailRequestToken = 0;
  let fieldDecisions = {};
  let fieldValues = {};
  let moderationComment = '';
  let moderationBusy = false;
  let reassignTargetType = 'way';
  let reassignTargetId = '';
  let reassignForce = false;
  let pendingUrlEditId = null;
  let adminUrlSyncBusy = false;
  let lastAppliedUrlEditId = null;

  let general = {
    appDisplayName: 'archimap',
    appBaseUrl: '',
    registrationEnabled: true,
    userEditRequiresPermission: true
  };
  let generalLoading = false;
  let generalStatus = '';
  let smtp = { url: '', host: '', port: 587, secure: false, user: '', pass: '', from: '', hasPassword: false };
  let smtpLoading = false;
  let smtpStatus = '';
  let smtpTestEmail = '';
  let dataSettings = {
    source: 'db',
    bootstrap: { completed: false, source: null },
    regions: [],
    filterTags: {
      source: 'default',
      allowlist: [],
      defaultAllowlist: [],
      availableKeys: [],
      updatedBy: null,
      updatedAt: null
    }
  };
  let dataLoading = false;
  let dataStatus = '';
  let filterTagAllowlistDraft = [];
  let filterTagAllowlistSaving = false;
  let sortedAvailableFilterTagKeys = [];
  let filterTagAllowlistDirty = false;
  let filterTagDraftStateByKey = {};
  let regionDraft = createRegionDraft();
  let regionSaving = false;
  let regionDeleting = false;
  let regionSyncBusy = false;
  let selectedDataRegionId = null;
  let regionRuns = [];
  let regionRunsLoading = false;
  let regionRunsStatus = '';

  let mapEl;
  let map = null;
  let maplibregl = null;
  let mapRuntimePromise = null;
  let protocol = null;
  let mapInitNonce = 0;
  let activeRegionPmtiles = [];
  const centerByKey = new Map();
  const editIdByKey = new Map();

  const msg = (e, f) => String(e?.message || f);
  const dataT = (key, params = {}) => translateNow(`${DATA_I18N_PREFIX}.${key}`, params);

  function resetReassignDraft() {
    reassignTargetType = 'way';
    reassignTargetId = '';
    reassignForce = false;
  }

  function seedReassignDraft(item) {
    reassignTargetType = String(item?.osmType || 'way').trim() || 'way';
    reassignTargetId = '';
    reassignForce = false;
  }

  function createRegionDraft(region = null) {
    return {
      id: Number(region?.id || 0) || null,
      name: String(region?.name || ''),
      slug: String(region?.slug || ''),
      sourceType: String(region?.sourceType || 'extract_query'),
      sourceValue: String(region?.sourceValue || ''),
      enabled: region?.enabled !== false,
      autoSyncEnabled: region?.autoSyncEnabled !== false,
      autoSyncOnStart: Boolean(region?.autoSyncOnStart),
      autoSyncIntervalHours: Number(region?.autoSyncIntervalHours ?? 168) || 0,
      pmtilesMinZoom: Number(region?.pmtilesMinZoom ?? 13) || 0,
      pmtilesMaxZoom: Number(region?.pmtilesMaxZoom ?? 16) || 0,
      sourceLayer: String(region?.sourceLayer || 'buildings')
    };
  }

  function getRegionStatusMeta(status) {
    const code = String(status || 'idle')
      .trim()
      .toLowerCase();
    if (code === 'running') return { text: dataT('runStatus.running'), tone: 'running' };
    if (code === 'queued') return { text: dataT('runStatus.queued'), tone: 'queued' };
    if (code === 'failed' || code === 'abandoned') return { text: dataT('runStatus.failed'), tone: 'failed' };
    if (code === 'success') return { text: dataT('runStatus.success'), tone: 'success' };
    return { text: dataT('runStatus.planned'), tone: 'idle' };
  }

  function formatRunTriggerReason(reason) {
    const code = String(reason || 'manual')
      .trim()
      .toLowerCase();
    if (code === 'scheduled') return dataT('triggers.scheduled');
    if (code === 'startup') return dataT('triggers.startup');
    return dataT('triggers.manual');
  }

  function getBootstrapStatusLabel(completed) {
    return completed ? dataT('summary.bootstrapDone') : dataT('summary.bootstrapPending');
  }

  function getRegionEnabledLabel(enabled) {
    return enabled ? dataT('list.enabled') : dataT('list.disabled');
  }

  function getRegionSyncModeLabel(region) {
    return region?.autoSyncEnabled
      ? dataT('list.everyHours', { hours: Number(region?.autoSyncIntervalHours || 0) })
      : dataT('list.manualOnly');
  }

  function getRegionById(regionId) {
    return dataSettings.regions.find((item) => Number(item?.id || 0) === Number(regionId)) || null;
  }

  function formatStorageBytes(value, options = {}) {
    const { fallback = '—' } = options;
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return fallback;
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(digits)} ${units[unitIndex]}`;
  }

  function seedFilterTagAllowlistDraft(filterTags = null) {
    const current = filterTags && typeof filterTags === 'object' ? filterTags : {};
    filterTagAllowlistDraft = Array.isArray(current.allowlist) ? [...current.allowlist] : [];
  }

  function isFilterTagSelected(key) {
    return filterTagAllowlistDraft.includes(String(key || '').trim());
  }

  function getSavedFilterTagAllowlist() {
    return Array.isArray(dataSettings?.filterTags?.allowlist) ? dataSettings.filterTags.allowlist : [];
  }

  function getFilterTagDraftState(key) {
    const normalized = String(key || '').trim();
    if (!normalized) return 'unchanged';
    const saved = new Set(getSavedFilterTagAllowlist());
    const current = new Set(filterTagAllowlistDraft);
    if (current.has(normalized) && !saved.has(normalized)) return 'enabled_pending';
    if (!current.has(normalized) && saved.has(normalized)) return 'disabled_pending';
    return 'unchanged';
  }

  function getFilterTagDraftClass(state) {
    if (state === 'enabled_pending') return 'filter-tag-option-enabled-pending';
    if (state === 'disabled_pending') return 'filter-tag-option-disabled-pending';
    return 'filter-tag-option-unchanged';
  }

  function buildFilterTagDraftStateByKey(keys = [], saved = [], draft = []) {
    const result = {};
    const savedSet = new Set(Array.isArray(saved) ? saved : []);
    const draftSet = new Set(Array.isArray(draft) ? draft : []);
    for (const rawKey of Array.isArray(keys) ? keys : []) {
      const key = String(rawKey || '').trim();
      if (!key) continue;
      if (draftSet.has(key) && !savedSet.has(key)) {
        result[key] = 'enabled_pending';
        continue;
      }
      if (!draftSet.has(key) && savedSet.has(key)) {
        result[key] = 'disabled_pending';
        continue;
      }
      result[key] = 'unchanged';
    }
    return result;
  }

  function confirmDiscardFilterTagChanges() {
    if (!filterTagAllowlistDirty) return true;
    if (typeof window === 'undefined') return false;
    return window.confirm(dataT('filterTags.confirmDiscard'));
  }

  function ensureFilterTagChangesDiscarded() {
    return confirmDiscardFilterTagChanges();
  }

  function toggleFilterTagSelection(key, checked) {
    const nextKey = String(key || '').trim();
    if (!nextKey) return;
    if (checked) {
      if (filterTagAllowlistDraft.includes(nextKey)) return;
      filterTagAllowlistDraft = [...filterTagAllowlistDraft, nextKey];
      return;
    }
    filterTagAllowlistDraft = filterTagAllowlistDraft.filter((item) => item !== nextKey);
  }

  function sortFilterTagKeys(keys = [], selected = []) {
    const selectedSet = new Set(Array.isArray(selected) ? selected : []);
    return [...(Array.isArray(keys) ? keys : [])].sort((left, right) => {
      const leftSelected = selectedSet.has(left);
      const rightSelected = selectedSet.has(right);
      if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
      return String(left || '').localeCompare(String(right || ''), 'en', { sensitivity: 'base' });
    });
  }

  function resetFilterTagAllowlistToDefault() {
    const defaults = Array.isArray(dataSettings?.filterTags?.defaultAllowlist)
      ? dataSettings.filterTags.defaultAllowlist
      : [];
    const available = new Set(Array.isArray(dataSettings?.filterTags?.availableKeys) ? dataSettings.filterTags.availableKeys : []);
    filterTagAllowlistDraft = defaults.filter((key) => available.has(key));
  }

  $: sortedAvailableFilterTagKeys = sortFilterTagKeys(
    dataSettings?.filterTags?.availableKeys,
    getSavedFilterTagAllowlist()
  );
  $: filterTagDraftStateByKey = buildFilterTagDraftStateByKey(
    dataSettings?.filterTags?.availableKeys,
    getSavedFilterTagAllowlist(),
    filterTagAllowlistDraft
  );
  $: filterTagAllowlistDirty = (() => {
    const saved = [...getSavedFilterTagAllowlist()].sort();
    const draft = [...filterTagAllowlistDraft].sort();
    return JSON.stringify(saved) !== JSON.stringify(draft);
  })();

  onMount(() => {
    if (typeof window === 'undefined') return undefined;
    const onBeforeUnload = (event) => {
      if (!filterTagAllowlistDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  });

  beforeNavigate((navigation) => {
    if (!filterTagAllowlistDirty) return;
    const nextPathname = String(navigation?.to?.url?.pathname || '').trim();
    if (!nextPathname) return;
    if (typeof window !== 'undefined' && nextPathname !== window.location.pathname && !confirmDiscardFilterTagChanges()) {
      navigation.cancel();
    }
  });

  function getActiveTabLabel(tab = activeTab) {
    if (tab === 'users') return translateNow('admin.tabs.users');
    if (tab === 'settings') return translateNow('admin.tabs.settings');
    if (tab === 'data') return translateNow('admin.tabs.data');
    return translateNow('admin.tabs.edits');
  }

  async function ensureMapRuntime() {
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

  function ensureAdminBuildingLayers(cfg) {
    if (!map) return;
    const regions = Array.isArray(cfg?.buildingRegionsPmtiles) ? cfg.buildingRegionsPmtiles : [];
    activeRegionPmtiles = regions;

    if (!map.getSource('selected-building')) {
      map.addSource('selected-building', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getSource(SRC)) {
      map.addSource(SRC, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
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

    if (!map.getLayer('selected-fill'))
      map.addLayer({
        id: 'selected-fill',
        type: 'fill',
        source: 'selected-building',
        paint: { 'fill-color': '#4F4A43', 'fill-opacity': 0.2 }
      });
    if (!map.getLayer('selected-line'))
      map.addLayer({
        id: 'selected-line',
        type: 'line',
        source: 'selected-building',
        paint: { 'line-color': '#2B2824', 'line-width': 3 }
      });
    if (!map.getLayer(L_CLUSTER))
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
    if (!map.getLayer(L_COUNT))
      map.addLayer({
        id: L_COUNT,
        type: 'symbol',
        source: SRC,
        filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Open Sans Bold'] },
        paint: { 'text-color': MAP_PIN_INK }
      });
    if (!map.getLayer(L_POINT))
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

  function focusMapOnFeature(feature) {
    focusMapOnGeometry(map, maplibregl, feature?.geometry);
  }

  function fitAllEdited() {
    if (!map || !maplibregl?.LngLatBounds) return;
    const bounds = new maplibregl.LngLatBounds();
    let count = 0;
    for (const key of editIdByKey.keys()) {
      const c = centerByKey.get(key);
      if (!c) continue;
      bounds.extend(c);
      count += 1;
    }
    if (count > 0 && !bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, duration: 450, maxZoom: 17 });
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
    const cfg = getRuntimeConfig();
    map = new maplibregl.Map({
      container: mapEl,
      style: styleByTheme(),
      center: [cfg.mapDefault.lon, cfg.mapDefault.lat],
      zoom: Math.max(12, Number(cfg.mapDefault.zoom || 14)),
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
      ensureAdminBuildingLayers(cfg);
      applyMapData();
      fitAllEdited();
    });
    map.on('click', L_CLUSTER, (e) => {
      const f = e?.features?.[0];
      const id = Number(f?.properties?.cluster_id);
      const src = map.getSource(SRC);
      if (!Number.isInteger(id) || !src?.getClusterExpansionZoom) return;
      src.getClusterExpansionZoom(id, (err, z) => {
        if (!err) map.easeTo({ center: f.geometry?.coordinates || map.getCenter(), zoom: z, duration: 300 });
      });
    });
    map.on('click', L_POINT, async (e) => {
      const id = Number(e?.features?.[0]?.properties?.editId || 0);
      if (Number.isInteger(id) && id > 0) await openEdit(id);
    });
    map.on('click', async (e) => {
      const clusterFeatures = map.queryRenderedFeatures(e.point, { layers: [L_CLUSTER, L_POINT] });
      if (Array.isArray(clusterFeatures) && clusterFeatures.length > 0) return;
      const buildingFeatures = map.queryRenderedFeatures(e.point, { layers: getEditedFillLayerIds() });
      const v = Number(buildingFeatures?.[0]?.id);
      if (!Number.isInteger(v)) return;
      const key = `${v % 2 === 1 ? 'relation' : 'way'}/${Math.floor(v / 2)}`;
      const id = Number(editIdByKey.get(key) || 0);
      if (id > 0) await openEdit(id);
    });
  }

  function destroyMap() {
    mapInitNonce += 1;
    if (!map) return;
    map.remove();
    map = null;
  }

  function applyMapData() {
    if (!map || !map.getSource(SRC)) return;
    const features = [];
    const ids = [];
    for (const item of visibleEdits) {
      const key = getEditKey(item);
      if (!key) continue;
      const c = centerByKey.get(key);
      if (c)
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: c },
          properties: { osmKey: key, editId: Number(item.id || item.editId || 0) }
        });
      const p = parseEditKey(key);
      if (p) ids.push(p.osmId * 2 + (p.osmType === 'relation' ? 1 : 0));
    }
    map.getSource(SRC).setData({ type: 'FeatureCollection', features });
    for (const layerId of getEditedFillLayerIds()) {
      if (map.getLayer(layerId)) map.setFilter(layerId, ['in', ['id'], ['literal', ids]]);
    }
    for (const layerId of getEditedLineLayerIds()) {
      if (map.getLayer(layerId)) map.setFilter(layerId, ['in', ['id'], ['literal', ids]]);
    }
  }

  async function replaceAdminUrlState(patch) {
    if (typeof window === 'undefined') return;
    const current = new URL(window.location.href);
    const next = patchUrlState(current, patch);
    if (next.toString() === current.toString()) return;
    adminUrlSyncBusy = true;
    try {
      await goto(`${next.pathname}${next.search}${next.hash}`, {
        replaceState: true,
        keepFocus: true,
        noScroll: true
      });
    } finally {
      queueMicrotask(() => {
        adminUrlSyncBusy = false;
      });
    }
  }

  async function loadCenters(items) {
    for (const item of items) {
      const key = getEditKey(item);
      if (!key || centerByKey.has(key)) continue;
      const p = parseEditKey(key);
      if (!p) continue;
      try {
        const f = await apiJson(`/api/building/${encodeURIComponent(p.osmType)}/${encodeURIComponent(p.osmId)}`);
        const c = getGeometryCenter(f?.geometry);
        if (c) centerByKey.set(key, c);
      } catch {}
    }
  }

  async function loadUsers() {
    usersLoading = true;
    usersStatus = translateNow('admin.loading');
    try {
      const p = new URLSearchParams();
      if (String(usersQuery || '').trim()) p.set('q', String(usersQuery).trim());
      if (usersRole === 'admin' || usersRole === 'user') p.set('role', usersRole);
      if (usersCanEdit === 'yes') p.set('canEdit', 'true');
      if (usersCanEdit === 'no') p.set('canEdit', 'false');
      if (usersHasEdits === 'yes') p.set('hasEdits', 'true');
      if (usersHasEdits === 'no') p.set('hasEdits', 'false');
      p.set('sortBy', usersSortBy);
      p.set('sortDir', usersSortDir);
      const data = await apiJson(`/api/admin/users?${p.toString()}`);
      users = Array.isArray(data?.items) ? data.items : [];
      usersStatus = users.length
        ? translateNow('admin.users.found', { count: users.length })
        : translateNow('admin.empty');
    } catch (e) {
      users = [];
      usersStatus = msg(e, translateNow('admin.users.loadFailed'));
    } finally {
      usersLoading = false;
    }
  }

  async function toggleCanEdit(user) {
    try {
      await apiJson('/api/admin/users/edit-permission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: String(user?.email || '')
            .trim()
            .toLowerCase(),
          canEdit: !Boolean(user?.canEdit)
        })
      });
      await loadUsers();
    } catch (e) {
      usersStatus = msg(e, translateNow('admin.users.permUpdateFailed'));
    }
  }

  async function toggleAdmin(user) {
    try {
      await apiJson('/api/admin/users/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: String(user?.email || '')
            .trim()
            .toLowerCase(),
          isAdmin: !Boolean(user?.isAdmin)
        })
      });
      await loadUsers();
    } catch (e) {
      usersStatus = msg(e, translateNow('admin.users.roleUpdateFailed'));
    }
  }

  async function loadEdits() {
    editsLoading = true;
    editsStatus = translateNow('admin.loading');
    try {
      const p = new URLSearchParams();
      p.set('status', 'all');
      p.set('limit', String(editsLimit));
      const data = await apiJson(`/api/admin/building-edits?${p.toString()}`);
      edits = Array.isArray(data?.items) ? data.items : [];
      visibleEdits = [...edits];
      editsUsers = [
        ...new Set(
          edits
            .map((item) =>
              String(item?.updatedBy || '')
                .trim()
                .toLowerCase()
            )
            .filter(Boolean)
        )
      ].sort();
      editIdByKey.clear();
      for (const item of visibleEdits) {
        const key = getEditKey(item);
        if (key) editIdByKey.set(key, Number(item.id || item.editId || 0));
      }
      await loadCenters(visibleEdits);
      await ensureMap();
      applyMapData();
      fitAllEdited();
      editsStatus = visibleEdits.length
        ? translateNow('admin.edits.statusShown', { visible: visibleEdits.length, total: edits.length })
        : translateNow('admin.empty');
      await maybeOpenPendingUrlEdit();
    } catch (e) {
      edits = [];
      visibleEdits = [];
      editsStatus = msg(e, translateNow('admin.edits.loadFailed'));
    } finally {
      editsLoading = false;
    }
  }

  async function openEdit(editId) {
    const id = Number(editId);
    if (!Number.isInteger(id) || id <= 0) return;
    pendingUrlEditId = null;
    const requestToken = ++detailRequestToken;
    detailPaneVisible = true;
    selectedEdit = null;
    detailLoading = true;
    detailStatus = translateNow('admin.loading');
    fieldDecisions = {};
    fieldValues = {};
    moderationComment = '';
    try {
      const data = await apiJson(`/api/admin/building-edits/${id}`);
      if (requestToken !== detailRequestToken) return;
      selectedEdit = data?.item || null;
      lastAppliedUrlEditId = id;
      replaceAdminUrlState({ editId: id });
      const nextD = {};
      const nextV = {};
      for (const ch of Array.isArray(selectedEdit?.changes) ? selectedEdit.changes : []) {
        const f = String(ch?.field || '').trim();
        if (!f) continue;
        nextD[f] = 'accept';
        nextV[f] = ch?.localValue == null ? '' : String(ch.localValue);
      }
      fieldDecisions = nextD;
      fieldValues = nextV;
      seedReassignDraft(selectedEdit);
      detailStatus = '';
      try {
        const feature = await apiJson(
          `/api/building/${encodeURIComponent(selectedEdit.osmType)}/${encodeURIComponent(selectedEdit.osmId)}`
        );
        if (requestToken !== detailRequestToken) return;
        if (map?.getSource('selected-building')) map.getSource('selected-building').setData(feature);
        focusMapOnFeature(feature);
      } catch {}
    } catch (e) {
      if (requestToken !== detailRequestToken) return;
      selectedEdit = null;
      detailStatus = msg(e, translateNow('admin.edits.detailsLoadFailed'));
    } finally {
      if (requestToken === detailRequestToken) detailLoading = false;
    }
  }

  function closeEditPanel() {
    detailRequestToken += 1;
    detailPaneVisible = false;
    replaceAdminUrlState({ editId: null });
  }

  async function resetEditPanelState() {
    detailRequestToken += 1;
    detailPaneVisible = false;
    selectedEdit = null;
    detailLoading = false;
    detailStatus = '';
    fieldDecisions = {};
    fieldValues = {};
    moderationComment = '';
    resetReassignDraft();
    pendingUrlEditId = null;
    lastAppliedUrlEditId = null;
    if (map?.getSource('selected-building')) {
      map.getSource('selected-building').setData({ type: 'FeatureCollection', features: [] });
    }
    await replaceAdminUrlState({ editId: null });
  }

  function onDetailPaneOutroEnd() {
    if (detailPaneVisible) return;
    selectedEdit = null;
    detailLoading = false;
    detailStatus = '';
    fieldDecisions = {};
    fieldValues = {};
    moderationComment = '';
    resetReassignDraft();
    if (map?.getSource('selected-building')) {
      map.getSource('selected-building').setData({ type: 'FeatureCollection', features: [] });
    }
  }

  function setAll(decision) {
    const n = {};
    for (const f of Object.keys(fieldDecisions)) n[f] = decision;
    fieldDecisions = n;
  }

  function commentWithRejected(base, rejected) {
    const b = String(base || '').trim();
    if (!rejected.length) return b;
    const note = translateNow('admin.edits.commentRejectedFields', { fields: rejected.join(', ') });
    return b ? `${b}\n\n${note}` : note;
  }

  async function applyDecision(mode) {
    if (!selectedEdit || moderationBusy) return;
    moderationBusy = true;
    try {
      if (mode === 'reject') {
        await apiJson(`/api/admin/building-edits/${selectedEdit.editId || selectedEdit.id}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment: moderationComment })
        });
      } else {
        const accepted = [];
        const rejected = [];
        for (const [f, d] of Object.entries(fieldDecisions)) {
          if (d === 'reject') rejected.push(f);
          else accepted.push(f);
        }
        if (accepted.length === 0) {
          await apiJson(`/api/admin/building-edits/${selectedEdit.editId || selectedEdit.id}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comment: commentWithRejected(moderationComment, rejected) })
          });
        } else {
          const values = {};
          for (const f of accepted) values[f] = String(fieldValues[f] ?? '');
          await apiJson(`/api/admin/building-edits/${selectedEdit.editId || selectedEdit.id}/merge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: accepted,
              values,
              comment: commentWithRejected(moderationComment, rejected)
            })
          });
        }
      }
      await loadEdits();
      await openEdit(selectedEdit.editId || selectedEdit.id);
    } catch (e) {
      detailStatus = msg(e, translateNow('admin.edits.decisionFailed'));
    } finally {
      moderationBusy = false;
    }
  }

  async function reassignSelectedEdit() {
    if (!selectedEdit || moderationBusy) return;
    const targetOsmId = Number(reassignTargetId);
    if (!['way', 'relation'].includes(String(reassignTargetType || '').trim()) || !Number.isInteger(targetOsmId) || targetOsmId <= 0) {
      detailStatus = translateNow('admin.edits.reassignInvalidTarget');
      return;
    }

    moderationBusy = true;
    try {
      await apiJson(`/api/admin/building-edits/${selectedEdit.editId || selectedEdit.id}/reassign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: {
            osmType: reassignTargetType,
            osmId: targetOsmId
          },
          force: reassignForce
        })
      });
      await loadEdits();
      await openEdit(selectedEdit.editId || selectedEdit.id);
      detailStatus = translateNow('admin.edits.reassignDone');
    } catch (e) {
      detailStatus = msg(e, translateNow('admin.edits.reassignFailed'));
    } finally {
      moderationBusy = false;
    }
  }

  async function deleteSelectedEdit() {
    if (!$session.user?.isMasterAdmin || !selectedEdit || moderationBusy) return;
    const editId = Number(selectedEdit.editId || selectedEdit.id || 0);
    if (!Number.isInteger(editId) || editId <= 0) return;

    if (typeof window !== 'undefined') {
      const label = `${selectedEdit.osmType}/${selectedEdit.osmId} #${editId}`;
      const confirmed = window.confirm(translateNow('admin.edits.deleteConfirm', { label }));
      if (!confirmed) return;
    }

    moderationBusy = true;
    try {
      await apiJson(`/api/admin/building-edits/${editId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      await loadEdits();
      await closeEditPanel();
      editsStatus = translateNow('admin.edits.deleteDone');
    } catch (e) {
      detailStatus = msg(e, translateNow('admin.edits.deleteFailed'));
    } finally {
      moderationBusy = false;
    }
  }

  async function loadGeneral() {
    generalLoading = true;
    generalStatus = translateNow('admin.loading');
    try {
      const data = await apiJson('/api/admin/app-settings/general');
      general = data?.item?.general || general;
      generalStatus = '';
    } catch (e) {
      generalStatus = msg(e, translateNow('admin.settings.loadGeneralFailed'));
    } finally {
      generalLoading = false;
    }
  }

  async function saveGeneral(event) {
    event.preventDefault();
    generalLoading = true;
    generalStatus = translateNow('admin.settings.saving');
    try {
      await apiJson('/api/admin/app-settings/general', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ general })
      });
      generalStatus = translateNow('admin.settings.saved');
    } catch (e) {
      generalStatus = msg(e, translateNow('admin.settings.saveGeneralFailed'));
    } finally {
      generalLoading = false;
    }
  }

  async function loadSmtp() {
    smtpLoading = true;
    smtpStatus = translateNow('admin.loading');
    try {
      const data = await apiJson('/api/admin/app-settings/smtp');
      const s = data?.item?.smtp || {};
      smtp = {
        url: String(s.url || ''),
        host: String(s.host || ''),
        port: Number(s.port || 587),
        secure: Boolean(s.secure),
        user: String(s.user || ''),
        pass: '',
        from: String(s.from || ''),
        hasPassword: Boolean(s.hasPassword)
      };
      smtpStatus = '';
    } catch (e) {
      smtpStatus = msg(e, translateNow('admin.settings.loadSmtpFailed'));
    } finally {
      smtpLoading = false;
    }
  }

  async function saveSmtp(event) {
    event.preventDefault();
    smtpLoading = true;
    smtpStatus = translateNow('admin.settings.saving');
    try {
      await apiJson('/api/admin/app-settings/smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ smtp: { ...smtp, keepPassword: String(smtp.pass || '').trim() === '' } })
      });
      smtp.pass = '';
      smtpStatus = translateNow('admin.settings.smtpSaved');
    } catch (e) {
      smtpStatus = msg(e, translateNow('admin.settings.saveSmtpFailed'));
    } finally {
      smtpLoading = false;
    }
  }

  async function testSmtp() {
    smtpLoading = true;
    smtpStatus = translateNow('admin.settings.smtpTesting');
    try {
      const data = await apiJson('/api/admin/app-settings/smtp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testEmail: smtpTestEmail,
          smtp: { ...smtp, keepPassword: String(smtp.pass || '').trim() === '' }
        })
      });
      smtpStatus = String(data?.message || translateNow('admin.settings.smtpTestSent'));
    } catch (e) {
      smtpStatus = msg(e, translateNow('admin.settings.smtpTestFailed'));
    } finally {
      smtpLoading = false;
    }
  }

  async function loadRegionRuns(regionId) {
    const numericRegionId = Number(regionId || 0);
    if (!Number.isInteger(numericRegionId) || numericRegionId <= 0) {
      regionRuns = [];
      regionRunsStatus = '';
      return;
    }
    regionRunsLoading = true;
    regionRunsStatus = dataT('status.loadingHistory');
    try {
      const data = await apiJson(`/api/admin/app-settings/data/regions/${numericRegionId}/runs?limit=10`);
      regionRuns = Array.isArray(data?.items) ? data.items : [];
      regionRunsStatus = regionRuns.length > 0 ? '' : dataT('history.empty');
    } catch (e) {
      regionRuns = [];
      regionRunsStatus = msg(e, dataT('status.loadHistoryFailed'));
    } finally {
      regionRunsLoading = false;
    }
  }

  async function selectDataRegion(region) {
    const numericRegionId = Number(region?.id || 0);
    selectedDataRegionId = Number.isInteger(numericRegionId) && numericRegionId > 0 ? numericRegionId : null;
    regionDraft = createRegionDraft(region || null);
    if (selectedDataRegionId) {
      await loadRegionRuns(selectedDataRegionId);
      return;
    }
    regionRunsLoading = false;
    regionRuns = [];
    regionRunsStatus = '';
  }

  async function loadDataSettings(options = {}) {
    const { selectedRegionId = null, preserveSelection = true, ignoreUnsavedFilterTags = false } = options;
    if (!ignoreUnsavedFilterTags && !ensureFilterTagChangesDiscarded()) {
      return false;
    }
    dataLoading = true;
    dataStatus = dataT('status.loadingSettings');
    try {
      const data = await apiJson('/api/admin/app-settings/data');
      const nextSettings = data?.item && typeof data.item === 'object' ? data.item : dataSettings;
      dataSettings = {
        source: String(nextSettings?.source || 'db'),
        bootstrap: {
          completed: Boolean(nextSettings?.bootstrap?.completed),
          source: nextSettings?.bootstrap?.source ? String(nextSettings.bootstrap.source) : null
        },
        regions: Array.isArray(nextSettings?.regions) ? nextSettings.regions : [],
        filterTags: {
          source: String(nextSettings?.filterTags?.source || 'default'),
          allowlist: Array.isArray(nextSettings?.filterTags?.allowlist) ? nextSettings.filterTags.allowlist : [],
          defaultAllowlist: Array.isArray(nextSettings?.filterTags?.defaultAllowlist) ? nextSettings.filterTags.defaultAllowlist : [],
          availableKeys: Array.isArray(nextSettings?.filterTags?.availableKeys) ? nextSettings.filterTags.availableKeys : [],
          updatedBy: nextSettings?.filterTags?.updatedBy ? String(nextSettings.filterTags.updatedBy) : null,
          updatedAt: nextSettings?.filterTags?.updatedAt ? String(nextSettings.filterTags.updatedAt) : null
        }
      };
      seedFilterTagAllowlistDraft(dataSettings.filterTags);

      const nextSelectedRegionId =
        selectedRegionId != null
          ? Number(selectedRegionId || 0)
          : preserveSelection
            ? Number(selectedDataRegionId || 0)
            : 0;
      const selectedRegion = getRegionById(nextSelectedRegionId) || dataSettings.regions[0] || null;
      await selectDataRegion(selectedRegion);
      dataStatus = '';
      return true;
    } catch (e) {
      dataStatus = msg(e, dataT('status.loadSettingsFailed'));
      return false;
    } finally {
      dataLoading = false;
    }
  }

  async function saveFilterTagAllowlist() {
    filterTagAllowlistSaving = true;
    dataStatus = dataT('status.savingFilterTags');
    try {
      const payload = {
        allowlist: [...filterTagAllowlistDraft]
      };
      const data = await apiJson('/api/admin/app-settings/data/filter-tag-allowlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const saved = data?.item && typeof data.item === 'object' ? data.item : null;
      dataSettings = {
        ...dataSettings,
        filterTags: {
          ...dataSettings.filterTags,
          source: String(saved?.source || dataSettings.filterTags.source || 'default'),
          allowlist: Array.isArray(saved?.allowlist) ? saved.allowlist : [...filterTagAllowlistDraft],
          defaultAllowlist: Array.isArray(saved?.defaultAllowlist) ? saved.defaultAllowlist : dataSettings.filterTags.defaultAllowlist,
          updatedBy: saved?.updatedBy ? String(saved.updatedBy) : null,
          updatedAt: saved?.updatedAt ? String(saved.updatedAt) : null
        }
      };
      seedFilterTagAllowlistDraft(dataSettings.filterTags);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('archimap:filter-tag-keys-changed'));
      }
      dataStatus = dataT('status.filterTagsSaved');
    } catch (e) {
      dataStatus = msg(e, dataT('status.saveFilterTagsFailed'));
    } finally {
      filterTagAllowlistSaving = false;
    }
  }

  function startNewRegionDraft() {
    if (!ensureFilterTagChangesDiscarded()) return;
    selectedDataRegionId = null;
    regionDraft = createRegionDraft();
    regionRunsLoading = false;
    regionRuns = [];
    regionRunsStatus = '';
    dataStatus = '';
  }

  async function saveDataRegion(event) {
    event.preventDefault();
    if (!ensureFilterTagChangesDiscarded()) return;
    regionSaving = true;
    dataStatus = dataT('status.savingRegion');
    try {
      const payload = {
        ...(regionDraft.id ? { id: regionDraft.id } : {}),
        name: String(regionDraft.name || '').trim(),
        slug: String(regionDraft.slug || '').trim(),
        sourceType: 'extract_query',
        sourceValue: String(regionDraft.sourceValue || '').trim(),
        enabled: Boolean(regionDraft.enabled),
        autoSyncEnabled: Boolean(regionDraft.autoSyncEnabled),
        autoSyncOnStart: Boolean(regionDraft.autoSyncOnStart),
        autoSyncIntervalHours: Number(regionDraft.autoSyncIntervalHours || 0),
        pmtilesMinZoom: Number(regionDraft.pmtilesMinZoom || 0),
        pmtilesMaxZoom: Number(regionDraft.pmtilesMaxZoom || 0),
        sourceLayer: String(regionDraft.sourceLayer || '').trim()
      };
      const data = await apiJson('/api/admin/app-settings/data/regions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: payload })
      });
      const savedRegion = data?.item || null;
      await loadDataSettings({
        selectedRegionId: savedRegion?.id || regionDraft.id || null,
        preserveSelection: false
      });
      dataStatus = dataT('status.regionSaved');
    } catch (e) {
      dataStatus = msg(e, dataT('status.saveRegionFailed'));
    } finally {
      regionSaving = false;
    }
  }

  async function deleteDataRegion(regionId) {
    if (!ensureFilterTagChangesDiscarded()) return;
    const numericRegionId = Number(regionId || 0);
    if (!Number.isInteger(numericRegionId) || numericRegionId <= 0 || regionDeleting) return;
    const region = getRegionById(numericRegionId);
    const label = String(region?.name || region?.slug || `#${numericRegionId}`).trim();
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(dataT('confirmDelete', { label }));
      if (!confirmed) return;
    }

    regionDeleting = true;
    dataStatus = dataT('status.deletingRegion');
    try {
      await apiJson(`/api/admin/app-settings/data/regions/${numericRegionId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });
      await loadDataSettings({
        selectedRegionId: null,
        preserveSelection: false
      });
      dataStatus = dataT('status.regionDeleted');
    } catch (e) {
      dataStatus = msg(e, dataT('status.deleteRegionFailed'));
    } finally {
      regionDeleting = false;
    }
  }

  async function syncRegionNow(regionId) {
    if (!ensureFilterTagChangesDiscarded()) return;
    const numericRegionId = Number(regionId || 0);
    if (!Number.isInteger(numericRegionId) || numericRegionId <= 0) return;
    regionSyncBusy = true;
    dataStatus = dataT('status.queueingSync');
    try {
      await apiJson(`/api/admin/app-settings/data/regions/${numericRegionId}/sync-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      await loadDataSettings({
        selectedRegionId: numericRegionId,
        preserveSelection: false
      });
      dataStatus = dataT('status.queuedSync');
    } catch (e) {
      dataStatus = msg(e, dataT('status.syncFailed'));
    } finally {
      regionSyncBusy = false;
    }
  }

  async function switchTab(tab) {
    if (tab !== activeTab && !confirmDiscardFilterTagChanges()) {
      return;
    }
    activeTab = tab;
    await tick();
    if (tab === 'edits') {
      await ensureMap();
      map?.resize();
      applyMapData();
      fitAllEdited();
      await loadEdits();
      return;
    }
    await resetEditPanelState();
    destroyMap();
    if (tab === 'users') {
      loadUsers();
      return;
    }
    if (tab === 'settings') {
      loadGeneral();
      if ($session.user?.isMasterAdmin) {
        loadSmtp();
      }
      return;
    }
    if (tab === 'data' && $session.user?.isMasterAdmin) {
      loadDataSettings({ preserveSelection: true });
    }
  }

  async function maybeOpenPendingUrlEdit() {
    if (!$session.authenticated || !$session.user?.isAdmin) return;
    if (adminUrlSyncBusy || editsLoading || !pendingUrlEditId) return;
    const currentId = Number(selectedEdit?.editId || selectedEdit?.id || 0);
    if (currentId === pendingUrlEditId && detailPaneVisible) return;
    if (lastAppliedUrlEditId === pendingUrlEditId && currentId === pendingUrlEditId) return;
    if (activeTab !== 'edits') {
      await switchTab('edits');
      return;
    }
    await openEdit(pendingUrlEditId);
  }

  $: {
    const q = String(editsQuery || '')
      .trim()
      .toLowerCase();
    const date = String(editsDate || '').trim();
    const user = String(editsUser || '')
      .trim()
      .toLowerCase();
    const status = String(editsFilter || 'all')
      .trim()
      .toLowerCase();
    visibleEdits = edits.filter((item) => {
      const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`.toLowerCase();
      const address = getEditAddress(item).toLowerCase();
      const author = String(item?.updatedBy || '')
        .trim()
        .toLowerCase();
      const updatedAt = String(item?.updatedAt || '');
      if (q && !address.includes(q) && !osmKey.includes(q)) return false;
      if (date && !updatedAt.startsWith(date)) return false;
      if (user && author !== user) return false;
      if (
        status !== 'all' &&
        String(item?.status || '')
          .trim()
          .toLowerCase() !== status
      )
        return false;
      return true;
    });
    editIdByKey.clear();
    for (const item of visibleEdits) {
      const key = getEditKey(item);
      if (key) editIdByKey.set(key, Number(item.id || item.editId || 0));
    }
    if (map) {
      applyMapData();
      fitAllEdited();
    }
    editsStatus = editsLoading
      ? translateNow('admin.loading')
      : translateNow('admin.edits.statusShown', { visible: visibleEdits.length, total: edits.length });
  }

  $: adminPaneOpen = detailPaneVisible || detailLoading || Boolean(selectedEdit) || Boolean(detailStatus);

  onMount(() => {
    const unsubscribePage = page.subscribe(($pageState) => {
      const state = parseUrlState($pageState.url);
      const editId = Number(state?.editId || 0);
      pendingUrlEditId = Number.isInteger(editId) && editId > 0 ? editId : null;
      if (!adminUrlSyncBusy) {
        maybeOpenPendingUrlEdit();
      }
    });

    if ($session.authenticated && $session.user?.isAdmin) {
      loadEdits();
      loadUsers();
    }
    const obs = new MutationObserver(() => {
      if (map) map.setStyle(styleByTheme());
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      unsubscribePage();
      obs.disconnect();
      destroyMap();
    };
  });
</script>

{#if !$session.authenticated}
  <PortalFrame eyebrow="Archimap" title={$t('admin.title')} description={$t('admin.subtitle')}>
    <div class="portal-notice">
      <h2 class="text-xl font-extrabold text-slate-900">{$t('admin.authRequired')}</h2>
    </div>
  </PortalFrame>
{:else if !$session.user?.isAdmin}
  <PortalFrame eyebrow="Archimap" title={$t('admin.title')} description={$t('admin.subtitle')}>
    <div class="portal-notice">
      <h2 class="text-xl font-extrabold text-slate-900">{$t('admin.forbidden')}</h2>
    </div>
  </PortalFrame>
{:else}
  <PortalFrame eyebrow="Archimap" title={$t('admin.title')} description={$t('admin.subtitle')}>
    <svelte:fragment slot="meta">
      <span class="ui-chip"><strong>{$t('admin.tabs.users')}</strong>{users.length}</span>
      <span class="ui-chip"><strong>{$t('admin.tabs.edits')}</strong>{edits.length}</span>
    </svelte:fragment>

    <svelte:fragment slot="lead">
      <div class="portal-lead-grid">
        <article class="portal-stat">
          <span>{$t('admin.tabs.users')}</span>
          <strong>{users.length}</strong>
        </article>
        <article class="portal-stat">
          <span>{$t('admin.tabs.edits')}</span>
          <strong>{visibleEdits.length} / {edits.length}</strong>
        </article>
        <article class="portal-stat">
          <span>{$t('admin.currentSection')}</span>
          <strong>{getActiveTabLabel(activeTab)}</strong>
        </article>
      </div>
    </svelte:fragment>

    <ul class="ui-tab-shell flex flex-wrap gap-1" role="tablist">
      <li>
        <button
          type="button"
          class="ui-tab-btn"
          class:ui-tab-btn-active={activeTab === 'edits'}
          on:click={() => switchTab('edits')}>{$t('admin.tabs.edits')}</button
        >
      </li>
      <li>
        <button
          type="button"
          class="ui-tab-btn"
          class:ui-tab-btn-active={activeTab === 'users'}
          on:click={() => switchTab('users')}>{$t('admin.tabs.users')}</button
        >
      </li>
      <li>
        <button
          type="button"
          class="ui-tab-btn"
          class:ui-tab-btn-active={activeTab === 'data'}
          on:click={() => switchTab('data')}>{$t('admin.tabs.data')}</button
        >
      </li>
      <li>
        <button
          type="button"
          class="ui-tab-btn"
          class:ui-tab-btn-active={activeTab === 'settings'}
          on:click={() => switchTab('settings')}>{$t('admin.tabs.settings')}</button
        >
      </li>
    </ul>

    {#if activeTab === 'users'}
      <div class="mt-3 space-y-3">
        <form class="grid gap-2 lg:grid-cols-[1.4fr_repeat(4,minmax(0,1fr))]" on:submit|preventDefault={loadUsers}>
          <input class="ui-field" type="search" placeholder={$t('admin.users.search')} bind:value={usersQuery} />
          <select class="ui-field" bind:value={usersRole}
            ><option value="all">{$t('admin.users.roleAll')}</option><option value="admin"
              >{$t('admin.users.roleAdmins')}</option
            ><option value="user">{$t('admin.users.roleUsers')}</option></select
          >
          <select class="ui-field" bind:value={usersCanEdit}
            ><option value="all">{$t('admin.users.permAll')}</option><option value="yes"
              >{$t('admin.users.permYes')}</option
            ><option value="no">{$t('admin.users.permNo')}</option></select
          >
          <select class="ui-field" bind:value={usersHasEdits}
            ><option value="all">{$t('admin.users.editsAll')}</option><option value="yes"
              >{$t('admin.users.editsYes')}</option
            ><option value="no">{$t('admin.users.editsNo')}</option></select
          >
          <div class="flex gap-2">
            <select class="ui-field" bind:value={usersSortBy}
              ><option value="createdAt">{$t('admin.users.sortRegistered')}</option><option value="email"
                >{$t('admin.users.sortEmail')}</option
              ><option value="editsCount">{$t('admin.users.sortEditsCount')}</option><option value="lastEditAt"
                >{$t('admin.users.sortLastEdit')}</option
              ><option value="firstName">{$t('admin.users.sortFirstName')}</option><option value="lastName"
                >{$t('admin.users.sortLastName')}</option
              ></select
            ><select class="ui-field ui-field-xs" bind:value={usersSortDir}
              ><option value="desc">{$t('common.desc')}</option><option value="asc">{$t('common.asc')}</option></select
            ><button type="submit" class="ui-btn ui-btn-secondary">{$t('common.refresh')}</button>
          </div>
        </form>
        <p class="text-sm text-slate-600">{usersStatus}</p>
        <div class="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table class="min-w-full text-sm">
            <thead>
              <tr class="border-b border-slate-200 text-left text-slate-600">
                <th class="px-3 py-2">{$t('admin.users.table.email')}</th>
                <th class="px-3 py-2">{$t('admin.users.table.role')}</th>
                <th class="px-3 py-2">{$t('admin.users.table.edits')}</th>
                <th class="px-3 py-2">{$t('admin.users.table.registration')}</th>
                <th class="px-3 py-2">{$t('admin.users.table.lastEdit')}</th>
                <th class="px-3 py-2">{$t('admin.users.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {#if usersLoading}
                <tr><td colspan="6" class="px-3 py-3 text-slate-500">{$t('admin.loading')}</td></tr>
              {:else if users.length === 0}
                <tr><td colspan="6" class="px-3 py-3 text-slate-500">{$t('admin.empty')}</td></tr>
              {:else}
                {#each users as u (`${u.email}`)}
                  <tr class="border-b border-slate-100">
                    <td class="px-3 py-2">
                      <p class="font-semibold text-slate-900">{u.email}</p>
                      {#if u.firstName || u.lastName}
                        <p class="text-xs text-slate-500">
                          {String(u.firstName || '').trim()}
                          {String(u.lastName || '').trim()}
                        </p>
                      {/if}
                    </td>
                    <td class="px-3 py-2">
                      {#if u.isMasterAdmin}
                        <span
                          class="badge-pill mr-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700"
                          >{$t('admin.users.masterAdmin')}</span
                        >
                      {/if}
                      <span
                        class="badge-pill mr-1 rounded-full px-2.5 py-1 text-xs font-semibold {u.isAdmin
                          ? 'bg-slate-200 text-slate-800'
                          : 'bg-slate-100 text-slate-700'}"
                        >{u.isAdmin ? $t('admin.users.admin') : $t('admin.users.user')}</span
                      >
                      <span
                        class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {u.canEdit
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-slate-100 text-slate-700'}"
                        >{u.canEdit ? $t('admin.users.canEdit') : $t('admin.users.readOnly')}</span
                      >
                    </td>
                    <td class="px-3 py-2">{u.editsCount || 0}</td>
                    <td class="px-3 py-2">{formatUiDate(u.createdAt)}</td>
                    <td class="px-3 py-2">{formatUiDate(u.lastEditAt)}</td>
                    <td class="px-3 py-2">
                      <button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" on:click={() => toggleCanEdit(u)}
                        >{u.canEdit ? $t('admin.users.disableEdit') : $t('admin.users.enableEdit')}</button
                      >
                      <button
                        type="button"
                        class="ui-btn ui-btn-secondary ui-btn-xs"
                        on:click={() => toggleAdmin(u)}
                        disabled={!$session.user?.isMasterAdmin || Boolean(u.isMasterAdmin)}
                        >{u.isAdmin ? $t('admin.users.demoteAdmin') : $t('admin.users.promoteAdmin')}</button
                      >
                    </td>
                  </tr>
                {/each}
              {/if}
            </tbody>
          </table>
        </div>
      </div>
    {:else if activeTab === 'data'}
      {#if !$session.user?.isMasterAdmin}
        <p class="mt-3 text-sm text-slate-600">{$t('admin.settings.masterOnly')}</p>
      {:else}
        <section class="mt-3 space-y-4 rounded-2xl border border-slate-200 bg-white p-4 min-w-0">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="space-y-1">
              <h3 class="text-base font-bold text-slate-900">{$t('admin.data.title')}</h3>
              <p class="text-sm text-slate-600">{$t('admin.data.subtitle')}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="ui-btn ui-btn-secondary ui-btn-xs"
                on:click={() => loadDataSettings({ preserveSelection: true })}
                disabled={dataLoading || regionSaving || regionDeleting || regionSyncBusy}>{$t('common.refresh')}</button
              >
              <button
                type="button"
                class="ui-btn ui-btn-secondary ui-btn-xs"
                on:click={startNewRegionDraft}
                disabled={regionSaving || regionDeleting || regionSyncBusy}>{$t('admin.data.newRegion')}</button
              >
            </div>
          </div>

          <div class="grid gap-3 lg:grid-cols-3">
            <article class="data-summary-card rounded-xl p-3 text-sm text-slate-700">
              <p><strong>{$t('admin.data.summary.sourceLabel')}:</strong> {dataSettings.source}</p>
              <p>
                <strong>{$t('admin.data.summary.bootstrapLabel')}:</strong> {getBootstrapStatusLabel(
                  dataSettings.bootstrap.completed
                )}
              </p>
              <p>
                <strong>{$t('admin.data.summary.bootstrapSourceLabel')}:</strong>
                {dataSettings.bootstrap.source || $t('admin.data.summary.notAvailable')}
              </p>
            </article>
            <article class="data-summary-card rounded-xl p-3 text-sm text-slate-700 lg:col-span-2">
              <p><strong>{$t('admin.data.summary.syncModeLabel')}:</strong> {$t('admin.data.summary.syncModeValue')}</p>
              <p><strong>{$t('admin.data.summary.regionsCountLabel')}:</strong> {dataSettings.regions.length}</p>
              <p>
                <strong>{$t('admin.data.summary.regionSourceLabel')}:</strong> {$t('admin.data.summary.regionSourceValue')}
              </p>
            </article>
          </div>

          {#if dataStatus}
            <p class="text-sm text-slate-600">{dataStatus}</p>
          {/if}

          <section class="data-form-card space-y-3 rounded-2xl p-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 class="text-base font-bold text-slate-900">{$t('admin.data.filterTags.title')}</h4>
                <p class="text-sm text-slate-600">{$t('admin.data.filterTags.description')}</p>
              </div>
              <div class="text-xs text-slate-500">
                <p>{$t('admin.data.filterTags.source')}: {dataSettings.filterTags.source}</p>
                <p>{$t('admin.data.filterTags.selectedCount', { count: filterTagAllowlistDraft.length })}</p>
              </div>
            </div>

            <div class="flex flex-wrap gap-2 text-xs text-slate-500">
              <span class="rounded-full bg-slate-100 px-2 py-1">
                {$t('admin.data.filterTags.availableCount', { count: dataSettings.filterTags.availableKeys.length })}
              </span>
              {#if dataSettings.filterTags.updatedAt}
                <span class="rounded-full bg-slate-100 px-2 py-1">
                  {$t('admin.data.filterTags.updatedAt')}: {formatUiDate(dataSettings.filterTags.updatedAt)}
                </span>
              {/if}
              {#if dataSettings.filterTags.updatedBy}
                <span class="rounded-full bg-slate-100 px-2 py-1">
                  {$t('admin.data.filterTags.updatedBy')}: {dataSettings.filterTags.updatedBy}
                </span>
              {/if}
            </div>

            {#if filterTagAllowlistDirty}
              <div class="filter-tag-unsaved-warning rounded-xl px-3 py-2 text-sm">
                {$t('admin.data.filterTags.unsavedWarning')}
              </div>
            {/if}

            {#if dataSettings.filterTags.availableKeys.length === 0}
              <p class="rounded-xl border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500">
                {$t('admin.data.filterTags.empty')}
              </p>
            {:else}
              <div class="max-h-[28rem] overflow-auto rounded-xl border border-slate-200 bg-white p-3">
                <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {#each sortedAvailableFilterTagKeys as key (key)}
                    {@const draftState = filterTagDraftStateByKey[key] || 'unchanged'}
                    <label
                      class={`filter-tag-option ${getFilterTagDraftClass(draftState)} flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm`}
                    >
                      <input
                        type="checkbox"
                        checked={isFilterTagSelected(key)}
                        on:change={(event) => toggleFilterTagSelection(key, event.currentTarget.checked)}
                      />
                      <span class="break-all">{key}</span>
                    </label>
                  {/each}
                </div>
              </div>
            {/if}

            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="ui-btn ui-btn-secondary"
                disabled={dataLoading || filterTagAllowlistSaving}
                on:click={resetFilterTagAllowlistToDefault}>{$t('admin.data.filterTags.resetDefaults')}</button
              >
              <button
                type="button"
                class="ui-btn ui-btn-primary"
                disabled={dataLoading || filterTagAllowlistSaving}
                on:click={saveFilterTagAllowlist}>{$t('admin.data.filterTags.save')}</button
              >
            </div>
          </section>

          <div class="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <section class="space-y-3 min-w-0">
              <div class="flex items-center justify-between gap-2">
                <h4 class="text-sm font-semibold uppercase tracking-wide text-slate-600">{$t('admin.data.list.title')}</h4>
                <span class="text-xs text-slate-500">{dataSettings.regions.length}</span>
              </div>
              {#if dataLoading}
                <p class="data-summary-card rounded-xl px-3 py-2 text-sm text-slate-500">{$t('admin.data.list.loading')}</p>
              {:else if dataSettings.regions.length === 0}
                <p class="rounded-xl border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500">
                  {$t('admin.data.list.empty')}
                </p>
              {:else}
                <div class="space-y-2">
                  {#each dataSettings.regions as region (`data-region-${region.id}`)}
                    {@const statusMeta = getRegionStatusMeta(region.lastSyncStatus)}
                    <button
                      type="button"
                      class="data-region-card w-full rounded-xl px-3 py-3 text-left transition"
                      data-selected={selectedDataRegionId === region.id ? 'true' : 'false'}
                      on:click={() => selectDataRegion(region)}
                    >
                      <div class="flex flex-wrap items-start justify-between gap-2">
                        <div class="min-w-0 flex-1">
                          <p class="font-semibold text-slate-900 break-words">{region.name}</p>
                          <p class="text-xs text-slate-500 break-words">#{region.id} · {region.slug}</p>
                        </div>
                        <span
                          class="badge-pill data-status-pill shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold"
                          data-tone={statusMeta.tone}>{statusMeta.text}</span
                        >
                      </div>
                      <p class="mt-2 text-sm text-slate-700 break-all">{region.sourceValue}</p>
                      <div class="mt-2 grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
                        <p>{$t('admin.data.list.lastSync')}: {formatUiDate(region.lastSuccessfulSyncAt) || '—'}</p>
                        <p>{$t('admin.data.list.nextSync')}: {formatUiDate(region.nextSyncAt) || '—'}</p>
                        <p>{$t('admin.data.list.pmtilesSize')}: {formatStorageBytes(region.pmtilesBytes)}</p>
                        <p>
                          {$t('admin.data.list.dbSize')}:
                          {region.dbBytesApproximate ? '~' : ''}{formatStorageBytes(region.dbBytes)}
                        </p>
                      </div>
                      <div class="mt-2 flex flex-wrap gap-2 text-xs">
                        <span class="rounded-full bg-slate-100 px-2 py-1 text-slate-600"
                          >{getRegionEnabledLabel(region.enabled)}</span
                        >
                        <span class="rounded-full bg-slate-100 px-2 py-1 text-slate-600"
                          >{getRegionSyncModeLabel(region)}</span
                        >
                      </div>
                      {#if region.lastSyncError}
                        <p class="mt-2 text-xs text-rose-700 break-words">{region.lastSyncError}</p>
                      {/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </section>

            <section class="space-y-4 min-w-0">
              <form class="data-form-card space-y-3 rounded-2xl p-4" on:submit={saveDataRegion}>
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h4 class="text-base font-bold text-slate-900">
                      {regionDraft.id ? $t('admin.data.form.editTitle') : $t('admin.data.form.newTitle')}
                    </h4>
                    <p class="text-sm text-slate-600">
                      {$t('admin.data.form.description')}
                    </p>
                  </div>
                  {#if regionDraft.id}
                    <button
                      type="button"
                      class="ui-btn ui-btn-secondary ui-btn-xs"
                      on:click={startNewRegionDraft}
                      disabled={regionSaving || regionDeleting || regionSyncBusy}>{$t('admin.data.form.resetSelection')}</button
                    >
                  {/if}
                </div>

                <div class="grid gap-3 md:grid-cols-2">
                  {#if regionDraft.id}
                    <label class="space-y-1 text-sm text-slate-700">
                      <span>{$t('admin.data.form.regionId')}</span>
                      <input class="ui-field" value={regionDraft.id} readonly disabled />
                    </label>
                  {/if}
                  <label class="space-y-1 text-sm text-slate-700">
                    <span>{$t('admin.data.form.regionName')}</span>
                    <input class="ui-field" bind:value={regionDraft.name} placeholder={$t('admin.data.form.regionNamePlaceholder')} />
                  </label>
                  <label class="space-y-1 text-sm text-slate-700">
                    <span>{$t('admin.data.form.slug')}</span>
                    <input class="ui-field" bind:value={regionDraft.slug} placeholder={$t('admin.data.form.slugPlaceholder')} />
                  </label>
                  <label class="space-y-1 text-sm text-slate-700 md:col-span-2">
                    <span>{$t('admin.data.form.sourceValue')}</span>
                    <input class="ui-field" bind:value={regionDraft.sourceValue} placeholder={$t('admin.data.form.sourceValuePlaceholder')} />
                  </label>
                  <label class="space-y-1 text-sm text-slate-700">
                    <span>{$t('admin.data.form.sourceLayer')}</span>
                    <input class="ui-field" bind:value={regionDraft.sourceLayer} placeholder={$t('admin.data.form.sourceLayerPlaceholder')} />
                  </label>
                  <label class="space-y-1 text-sm text-slate-700">
                    <span>{$t('admin.data.form.sourceType')}</span>
                    <input class="ui-field" value="extract_query" disabled />
                  </label>
                  <label class="space-y-1 text-sm text-slate-700">
                    <span>{$t('admin.data.form.autoSyncIntervalHours')}</span>
                    <input
                      class="ui-field"
                      type="number"
                      min="0"
                      max="8760"
                      bind:value={regionDraft.autoSyncIntervalHours}
                    />
                  </label>
                  <label class="space-y-1 text-sm text-slate-700">
                    <span>{$t('admin.data.form.pmtilesMinZoom')}</span>
                    <input class="ui-field" type="number" min="0" max="22" bind:value={regionDraft.pmtilesMinZoom} />
                  </label>
                  <label class="space-y-1 text-sm text-slate-700">
                    <span>{$t('admin.data.form.pmtilesMaxZoom')}</span>
                    <input class="ui-field" type="number" min="0" max="22" bind:value={regionDraft.pmtilesMaxZoom} />
                  </label>
                </div>

                <div class="grid gap-2 md:grid-cols-2">
                  <label class="flex items-center gap-2 text-sm text-slate-700"
                    ><input type="checkbox" bind:checked={regionDraft.enabled} /> {$t('admin.data.form.enabled')}</label
                  >
                  <label class="flex items-center gap-2 text-sm text-slate-700"
                    ><input type="checkbox" bind:checked={regionDraft.autoSyncEnabled} /> {$t('admin.data.form.autoSyncEnabled')}</label
                  >
                  <label class="flex items-center gap-2 text-sm text-slate-700"
                    ><input type="checkbox" bind:checked={regionDraft.autoSyncOnStart} /> {$t('admin.data.form.autoSyncOnStart')}</label
                  >
                </div>

                {#if regionDraft.id}
                  {@const selectedRegion = getRegionById(regionDraft.id)}
                  {@const selectedStatusMeta = getRegionStatusMeta(selectedRegion?.lastSyncStatus)}
                  <div class="rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-700">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="font-semibold text-slate-900">{$t('admin.data.form.currentStatus')}</span>
                      <span
                        class="badge-pill data-status-pill rounded-full px-2.5 py-1 text-xs font-semibold"
                        data-tone={selectedStatusMeta.tone}>{selectedStatusMeta.text}</span
                      >
                    </div>
                    <div class="mt-2 grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
                      <p>{$t('admin.data.form.lastSync')}: {formatUiDate(selectedRegion?.lastSuccessfulSyncAt) || '—'}</p>
                      <p>{$t('admin.data.form.nextSync')}: {formatUiDate(selectedRegion?.nextSyncAt) || '—'}</p>
                      <p>{$t('admin.data.form.lastFinished')}: {formatUiDate(selectedRegion?.lastSyncFinishedAt) || '—'}</p>
                      <p>{$t('admin.data.form.pmtilesSize')}: {formatStorageBytes(selectedRegion?.pmtilesBytes)}</p>
                      <p>
                        {$t('admin.data.form.dbSize')}:
                        {selectedRegion?.dbBytesApproximate ? '~' : ''}{formatStorageBytes(selectedRegion?.dbBytes)}
                      </p>
                      <p class="break-words">
                        {$t('admin.data.form.bounds')}: {selectedRegion?.bounds
                          ? `${selectedRegion.bounds.west.toFixed(4)}, ${selectedRegion.bounds.south.toFixed(4)} .. ${selectedRegion.bounds.east.toFixed(4)}, ${selectedRegion.bounds.north.toFixed(4)}`
                          : $t('admin.data.form.boundsUnknown')}
                      </p>
                    </div>
                    {#if selectedRegion?.lastSyncError}
                      <p class="mt-2 text-xs text-rose-700 break-words">{selectedRegion.lastSyncError}</p>
                    {/if}
                  </div>
                {/if}

                <div class="flex flex-wrap gap-2">
                  <button type="submit" class="ui-btn ui-btn-primary" disabled={regionSaving || regionDeleting}
                    >{regionDraft.id ? $t('admin.data.form.saveRegion') : $t('admin.data.form.createRegion')}</button
                  >
                  <button
                    type="button"
                    class="ui-btn ui-btn-secondary"
                    disabled={!regionDraft.id || regionSaving || regionDeleting || regionSyncBusy}
                    on:click={() => syncRegionNow(regionDraft.id)}>{$t('admin.data.form.syncNow')}</button
                  >
                  <button
                    type="button"
                    class="ui-btn ui-btn-danger"
                    disabled={!regionDraft.id || regionSaving || regionDeleting || regionSyncBusy}
                    on:click={() => deleteDataRegion(regionDraft.id)}
                    >{regionDeleting ? $t('admin.data.form.deleting') : $t('admin.data.form.deleteRegion')}</button
                  >
                </div>
              </form>

              <section class="data-history-card rounded-2xl p-4 min-w-0">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <h4 class="text-base font-bold text-slate-900">{$t('admin.data.history.title')}</h4>
                  {#if regionRunsLoading}
                    <span class="text-sm text-slate-500">{$t('admin.data.history.loading')}</span>
                  {/if}
                </div>
                {#if regionRunsStatus}
                  <p class="mt-2 text-sm text-slate-600">{regionRunsStatus}</p>
                {/if}
                {#if selectedDataRegionId && regionRuns.length > 0}
                  <div class="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                    <table class="min-w-full text-sm">
                      <thead>
                        <tr class="border-b border-slate-200 text-left text-slate-600">
                          <th class="px-3 py-2">{$t('admin.data.history.run')}</th>
                          <th class="px-3 py-2">{$t('admin.data.history.trigger')}</th>
                          <th class="px-3 py-2">{$t('admin.data.history.status')}</th>
                          <th class="px-3 py-2">{$t('admin.data.history.requested')}</th>
                          <th class="px-3 py-2">{$t('admin.data.history.finished')}</th>
                          <th class="px-3 py-2">{$t('admin.data.history.features')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each regionRuns as run (`region-run-${run.id}`)}
                          {@const runStatusMeta = getRegionStatusMeta(run.status)}
                          <tr class="border-b border-slate-100">
                            <td class="px-3 py-2 font-medium text-slate-900">#{run.id}</td>
                            <td class="px-3 py-2 text-slate-600">{formatRunTriggerReason(run.triggerReason)}</td>
                            <td class="px-3 py-2"
                              ><span
                                class="badge-pill data-status-pill rounded-full px-2.5 py-1 text-xs font-semibold"
                                data-tone={runStatusMeta.tone}>{runStatusMeta.text}</span
                              ></td
                            >
                            <td class="px-3 py-2 text-slate-600"
                              >{formatUiDate(run.requestedAt || run.startedAt) || '—'}</td
                            >
                            <td class="px-3 py-2 text-slate-600">{formatUiDate(run.finishedAt) || '—'}</td>
                            <td class="px-3 py-2 text-slate-600"
                              >{run.activeFeatureCount ?? run.importedFeatureCount ?? '—'}</td
                            >
                          </tr>
                          {#if run.error}
                            <tr class="border-b border-slate-100 bg-rose-50">
                              <td colspan="6" class="px-3 py-2 text-xs text-rose-700">{run.error}</td>
                            </tr>
                          {/if}
                        {/each}
                      </tbody>
                    </table>
                  </div>
                {:else if !selectedDataRegionId}
                  <p class="mt-3 text-sm text-slate-500">{$t('admin.data.history.selectRegionHint')}</p>
                {/if}
              </section>
            </section>
          </div>
        </section>
      {/if}
    {:else if activeTab === 'settings'}
      {#if !$session.user?.isMasterAdmin}
        <p class="mt-3 text-sm text-slate-600">{$t('admin.settings.masterOnly')}</p>
      {:else}
        <div class="mt-3 grid gap-4 lg:grid-cols-2">
          <form class="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-4" on:submit={saveGeneral}>
            <h3 class="text-base font-bold text-slate-900">{$t('admin.settings.generalTitle')}</h3>
            <input
              class="ui-field"
              bind:value={general.appDisplayName}
              placeholder={$t('admin.settings.appNamePlaceholder')}
            /><input
              class="ui-field"
              bind:value={general.appBaseUrl}
              placeholder={$t('admin.settings.baseUrlPlaceholder')}
            /><label class="flex items-center gap-2 text-sm text-slate-700"
              ><input type="checkbox" bind:checked={general.registrationEnabled} />
              {$t('admin.settings.registrationEnabled')}</label
            ><label class="flex items-center gap-2 text-sm text-slate-700"
              ><input type="checkbox" bind:checked={general.userEditRequiresPermission} />
              {$t('admin.settings.editRequiresPermission')}</label
            ><button type="submit" class="ui-btn ui-btn-primary" disabled={generalLoading}>{$t('common.save')}</button
            >{#if generalStatus}<p class="text-sm text-slate-600">{generalStatus}</p>{/if}
          </form>
          <form class="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-4" on:submit={saveSmtp}>
            <h3 class="text-base font-bold text-slate-900">{$t('admin.settings.smtpTitle')}</h3>
            <input class="ui-field" bind:value={smtp.url} placeholder={$t('admin.settings.smtpUrl')} />
            <div class="grid gap-2 sm:grid-cols-2">
              <input class="ui-field" bind:value={smtp.host} placeholder={$t('admin.settings.host')} /><input
                class="ui-field"
                type="number"
                min="1"
                max="65535"
                bind:value={smtp.port}
                placeholder={$t('admin.settings.port')}
              />
            </div>
            <input class="ui-field" bind:value={smtp.user} placeholder={$t('admin.settings.user')} /><input
              class="ui-field"
              type="password"
              bind:value={smtp.pass}
              placeholder={smtp.hasPassword ? $t('admin.settings.passwordKeep') : $t('admin.settings.password')}
            /><input class="ui-field" bind:value={smtp.from} placeholder={$t('admin.settings.from')} /><label
              class="flex items-center gap-2 text-sm text-slate-700"
              ><input type="checkbox" bind:checked={smtp.secure} /> {$t('admin.settings.secure')}</label
            >
            <div class="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
              <input
                class="ui-field"
                type="email"
                bind:value={smtpTestEmail}
                placeholder={$t('admin.settings.testEmail')}
              /><button type="button" class="ui-btn ui-btn-secondary" on:click={testSmtp} disabled={smtpLoading}
                >{$t('admin.settings.smtpTest')}</button
              ><button type="submit" class="ui-btn ui-btn-primary" disabled={smtpLoading}
                >{$t('admin.settings.smtpSave')}</button
              >
            </div>
            {#if smtpStatus}<p class="text-sm text-slate-600">{smtpStatus}</p>{/if}
          </form>
        </div>
      {/if}
    {:else}
      <div
        class="mt-3 grid gap-4 overflow-x-hidden"
        class:lg:grid-cols-[1.1fr_1fr]={adminPaneOpen}
        class:lg:grid-cols-1={!adminPaneOpen}
      >
        <section class="space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
          <div class="grid gap-2 lg:grid-cols-[1.4fr_repeat(4,minmax(0,1fr))]">
            <input
              class="ui-field"
              type="search"
              placeholder={$t('admin.edits.search')}
              bind:value={editsQuery}
            /><input class="ui-field" type="date" bind:value={editsDate} /><select
              class="ui-field"
              bind:value={editsUser}
              ><option value="">{$t('admin.edits.userAll')}</option>{#each editsUsers as user (user)}<option
                  value={user}>{user}</option
                >{/each}</select
            ><select class="ui-field ui-field-xs" bind:value={editsFilter}
              ><option value="all">{$t('admin.edits.statusAll')}</option><option value="pending"
                >{$t('admin.edits.statusPending')}</option
              ><option value="accepted">{$t('admin.edits.statusAccepted')}</option><option value="partially_accepted"
                >{$t('admin.edits.statusPartiallyAccepted')}</option
              ><option value="rejected">{$t('admin.edits.statusRejected')}</option><option value="superseded"
                >{$t('admin.edits.statusSuperseded')}</option
              ></select
            >
            <div class="flex gap-2">
              <select class="ui-field ui-field-xs" bind:value={editsLimit} on:change={loadEdits}
                ><option value={100}>100</option><option value={200}>200</option><option value={500}>500</option
                ></select
              ><button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" on:click={loadEdits}
                >{$t('common.refresh')}</button
              >
            </div>
          </div>
          <p class="text-sm text-slate-600">{editsStatus}</p>
          <div
            class="h-[36vh] min-h-[260px] overflow-hidden rounded-xl border border-slate-200"
            bind:this={mapEl}
          ></div>
          <div class="overflow-x-auto rounded-xl border border-slate-200">
            <table class="min-w-full text-sm">
              <thead>
                <tr class="border-b border-slate-200 text-left text-slate-600">
                  <th class="px-3 py-2">{$t('admin.edits.tableBuilding')}</th>
                  <th class="px-3 py-2">{$t('admin.edits.tableAuthor')}</th>
                  <th class="px-3 py-2">{$t('admin.edits.tableStatus')}</th>
                  <th class="px-3 py-2">{$t('admin.edits.tableChanges')}</th>
                </tr>
              </thead>
              <tbody>
                {#if editsLoading}
                  <tr><td colspan="4" class="px-3 py-3 text-slate-500">{$t('admin.loading')}</td></tr>
                {:else if visibleEdits.length === 0}
                  <tr><td colspan="4" class="px-3 py-3 text-slate-500">{$t('admin.empty')}</td></tr>
                {:else}
                  {#each visibleEdits as it (`${it.id || it.editId}`)}
                    {@const statusMeta = getStatusBadgeMeta(it.status, translateNow)}
                    {@const counters = getChangeCounters(it.changes)}
                    <tr
                      class="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                      on:click={() => openEdit(it.id || it.editId)}
                    >
                      <td class="px-3 py-2"
                        ><p class="font-semibold text-slate-900">{getEditAddress(it)}</p>
                        <p class="text-xs text-slate-500">ID: {it.osmType}/{it.osmId}</p>
                        <div class="mt-1 flex flex-wrap gap-1">
                          {#if it.orphaned}<span class="rounded-md bg-rose-100 px-2 py-1 text-[11px] font-semibold text-rose-700"
                              >{$t('admin.edits.orphaned')}</span
                            >{/if}
                          {#if !it.osmPresent && !it.orphaned}<span
                              class="rounded-md bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-800"
                              >{$t('admin.edits.missingTarget')}</span
                            >{/if}
                          {#if it.sourceOsmChanged}<span
                              class="rounded-md bg-sky-100 px-2 py-1 text-[11px] font-semibold text-sky-800"
                              >{$t('admin.edits.osmChanged')}</span
                            >{/if}
                        </div></td
                      >
                      <td class="px-3 py-2">{it.updatedBy || '-'}</td>
                      <td class="px-3 py-2"
                        ><span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {statusMeta.cls}"
                          >{statusMeta.text}</span
                        ></td
                      >
                      <td class="px-3 py-2"
                        ><div class="flex flex-wrap items-center gap-2">
                          <span class="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600"
                            >{counters.total} {$t('admin.edits.changesTotal')}</span
                          >{#if counters.created > 0}<span
                              class="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-600"
                              >+{counters.created} {$t('admin.edits.changesCreated')}</span
                            >{/if}{#if counters.modified > 0}<span
                              class="rounded-md bg-slate-200 px-2 py-1 text-xs text-slate-700"
                              >~{counters.modified} {$t('admin.edits.changesModified')}</span
                            >{/if}
                        </div></td
                      >
                    </tr>
                  {/each}
                {/if}
              </tbody>
            </table>
          </div>
        </section>
        {#if detailPaneVisible}
          <section
            class="space-y-3 rounded-2xl border border-slate-200 bg-white p-3"
            in:fade={{ duration: 180 }}
            out:fade={{ duration: 180 }}
            on:outroend={onDetailPaneOutroEnd}
          >
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-base font-bold text-slate-900">{$t('admin.edits.detailTitle')}</h3>
              <button
                type="button"
                class="ui-btn ui-btn-secondary ui-btn-xs ui-btn-close"
                aria-label={$t('admin.edits.closeDetail')}
                on:click={closeEditPanel}
                ><svg class="ui-close-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"
                  ><path d="M6 6L18 18" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" /><path
                    d="M18 6L6 18"
                    stroke="currentColor"
                    stroke-width="2.25"
                    stroke-linecap="round"
                  /></svg
                ></button
              >
            </div>
            {#if detailLoading}
              <p class="text-sm text-slate-500">{$t('admin.loading')}</p>
            {:else if !selectedEdit}
              <p class="text-sm text-slate-500">{$t('admin.edits.selectHint')}</p>
            {:else}
              {@const selectedStatusMeta = getStatusBadgeMeta(selectedEdit.status, translateNow)}
              <p class="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <span>ID: {selectedEdit.editId || selectedEdit.id} | {selectedEdit.osmType}/{selectedEdit.osmId}</span
                ><span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {selectedStatusMeta.cls}"
                  >{selectedStatusMeta.text}</span
                >
              </p>
              {#if selectedEdit.orphaned || !selectedEdit.osmPresent || selectedEdit.sourceOsmChanged}
                <div class="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  {#if selectedEdit.orphaned}
                    <p>{$t('admin.edits.orphanedHelp')}</p>
                  {/if}
                  {#if !selectedEdit.osmPresent && !selectedEdit.orphaned}
                    <p>{$t('admin.edits.missingTargetHelp')}</p>
                  {/if}
                  {#if selectedEdit.sourceOsmChanged}
                    <p>{$t('admin.edits.osmChangedHelp')}</p>
                  {/if}
                </div>
              {/if}
              <div class="max-h-[42vh] space-y-2 overflow-auto rounded-xl border border-slate-200 p-2">
                {#if !Array.isArray(selectedEdit.changes) || selectedEdit.changes.length === 0}<p
                    class="text-sm text-slate-500"
                  >
                    {$t('admin.edits.noChanges')}
                  </p>{:else}{#each selectedEdit.changes as ch (`${ch.field}`)}<div
                      class="rounded-lg border border-slate-200 bg-slate-50 p-2"
                    >
                      <div class="mb-1 flex items-center justify-between gap-2">
                        <p class="text-sm font-semibold text-slate-900">{ch.label || ch.field}</p>
                        <div class="flex items-center gap-1">
                          <button
                            type="button"
                            class="ui-btn ui-btn-xs"
                            class:ui-btn-primary={fieldDecisions[ch.field] !== 'reject'}
                            class:ui-btn-secondary={fieldDecisions[ch.field] === 'reject'}
                            on:click={() => (fieldDecisions = { ...fieldDecisions, [ch.field]: 'accept' })}
                            >{$t('admin.edits.accept')}</button
                          ><button
                            type="button"
                            class="ui-btn ui-btn-xs"
                            class:ui-btn-primary={fieldDecisions[ch.field] === 'reject'}
                            class:ui-btn-secondary={fieldDecisions[ch.field] !== 'reject'}
                            on:click={() => (fieldDecisions = { ...fieldDecisions, [ch.field]: 'reject' })}
                            >{$t('admin.edits.reject')}</button
                          >
                        </div>
                      </div>
                      <p class="text-xs text-slate-600">
                        <span class="line-through">{String(ch.osmValue ?? $t('admin.edits.emptyValue'))}</span> ->
                        <strong>{String(ch.localValue ?? $t('admin.edits.emptyValue'))}</strong>
                      </p>
                      {#if fieldDecisions[ch.field] !== 'reject'}<input
                          class="ui-field mt-2"
                          value={fieldValues[ch.field] ?? ''}
                          on:input={(e) => (fieldValues = { ...fieldValues, [ch.field]: e.currentTarget.value })}
                        />{/if}
                    </div>{/each}{/if}
              </div>
              <textarea
                class="ui-field min-h-[84px]"
                placeholder={$t('admin.edits.moderatorComment')}
                bind:value={moderationComment}
              ></textarea>
              {#if selectedEdit.canReassign}
                <div class="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p class="text-sm font-semibold text-slate-900">{$t('admin.edits.reassignTitle')}</p>
                  <p class="text-xs text-slate-600">{$t('admin.edits.reassignHelp')}</p>
                  <div class="grid gap-2 sm:grid-cols-[120px_1fr_auto]">
                    <select class="ui-field" bind:value={reassignTargetType}>
                      <option value="way">way</option>
                      <option value="relation">relation</option>
                    </select>
                    <input
                      class="ui-field"
                      type="number"
                      min="1"
                      bind:value={reassignTargetId}
                      placeholder={$t('admin.edits.reassignTargetId')}
                    />
                    <button
                      type="button"
                      class="ui-btn ui-btn-secondary"
                      disabled={moderationBusy}
                      on:click={reassignSelectedEdit}>{$t('admin.edits.reassignAction')}</button
                    >
                  </div>
                  <label class="flex items-center gap-2 text-xs text-slate-700"
                    ><input type="checkbox" bind:checked={reassignForce} />
                    {$t('admin.edits.reassignForce')}</label
                  >
                </div>
              {/if}
              {#if $session.user?.isMasterAdmin}
                <div class="space-y-2 rounded-xl border border-rose-200 bg-rose-50 p-3">
                  <p class="text-sm font-semibold text-rose-900">{$t('admin.edits.deleteTitle')}</p>
                  {#if selectedEdit.canHardDelete}
                    <p class="text-xs text-rose-800">{$t('admin.edits.deleteHelp')}</p>
                  {:else if selectedEdit.hardDeleteBlockedReason === 'merged_with_other_accepted_edits'}
                    <p class="text-xs text-rose-800">{$t('admin.edits.deleteBlockedSharedMergedState')}</p>
                  {:else}
                    <p class="text-xs text-rose-800">{$t('admin.edits.deleteBlocked')}</p>
                  {/if}
                  <button
                    type="button"
                    class="ui-btn ui-btn-danger"
                    disabled={moderationBusy || !selectedEdit.canHardDelete}
                    on:click={deleteSelectedEdit}>{$t('admin.edits.deleteAction')}</button
                  >
                </div>
              {/if}
              <div class="flex flex-wrap gap-2">
                <button type="button" class="ui-btn ui-btn-secondary" on:click={() => setAll('accept')}
                  >{$t('admin.edits.acceptAll')}</button
                ><button type="button" class="ui-btn ui-btn-secondary" on:click={() => setAll('reject')}
                  >{$t('admin.edits.rejectAll')}</button
                ><button
                  type="button"
                  class="ui-btn ui-btn-primary"
                  disabled={moderationBusy}
                  on:click={() => applyDecision('apply')}>{$t('admin.edits.applyDecision')}</button
                ><button
                  type="button"
                  class="ui-btn ui-btn-danger"
                  disabled={moderationBusy}
                  on:click={() => applyDecision('reject')}>{$t('admin.edits.rejectEdit')}</button
                >
              </div>
              {#if detailStatus}<p class="text-sm text-slate-600">{detailStatus}</p>{/if}
            {/if}
          </section>
        {/if}
      </div>
    {/if}
  </PortalFrame>
{/if}

<style>
  .data-summary-card,
  .data-form-card,
  .data-history-card {
    border: 1px solid var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 84%, transparent);
    box-shadow: var(--shadow-soft);
  }

  .data-region-card {
    border: 1px solid var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 78%, transparent);
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
  }

  .data-region-card:hover {
    background: color-mix(in srgb, var(--panel-solid) 70%, var(--accent-soft));
  }

  .data-region-card[data-selected='true'] {
    border-color: color-mix(in srgb, var(--accent) 42%, var(--panel-border-strong));
    background: color-mix(in srgb, var(--accent-soft) 72%, var(--panel-solid));
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent),
      var(--shadow-soft);
  }

  .data-status-pill {
    border: 1px solid transparent;
  }

  .data-status-pill[data-tone='idle'] {
    background: #e2e8f0;
    color: #334155;
  }

  .data-status-pill[data-tone='queued'] {
    background: #dbeafe;
    color: #1d4ed8;
  }

  .data-status-pill[data-tone='running'] {
    background: #fef3c7;
    color: #92400e;
  }

  .data-status-pill[data-tone='success'] {
    background: #d1fae5;
    color: #047857;
  }

  .data-status-pill[data-tone='failed'] {
    background: #ffe4e6;
    color: #be123c;
  }

  :global(html[data-theme='dark']) .data-region-card {
    box-shadow: 0 14px 32px rgba(2, 6, 23, 0.28);
  }

  :global(html[data-theme='dark']) .data-region-card[data-selected='true'] {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--panel-border-strong));
    background: color-mix(in srgb, var(--accent-soft) 38%, var(--panel-solid));
  }

  :global(html[data-theme='dark']) .data-status-pill[data-tone='idle'] {
    background: #18233a;
    color: #dbe5f2;
  }

  :global(html[data-theme='dark']) .data-status-pill[data-tone='queued'] {
    background: #10213b;
    color: #93c5fd;
  }

  :global(html[data-theme='dark']) .data-status-pill[data-tone='running'] {
    background: #3f2a05;
    color: #fcd34d;
  }

  :global(html[data-theme='dark']) .data-status-pill[data-tone='success'] {
    background: #064e3b;
    color: #6ee7b7;
  }

  :global(html[data-theme='dark']) .data-status-pill[data-tone='failed'] {
    background: #4c1024;
    color: #fda4af;
  }

  .filter-tag-unsaved-warning {
    border: 1px solid #fcd34d;
    background: #fffbeb;
    color: #92400e;
  }

  :global(html[data-theme='dark']) .filter-tag-unsaved-warning {
    border-color: #b45309;
    background: #3f2a05;
    color: #fcd34d;
  }

  .filter-tag-option {
    border-color: var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 92%, transparent);
    color: var(--fg);
    transition:
      background-color 140ms ease,
      border-color 140ms ease,
      box-shadow 140ms ease;
  }

  .filter-tag-option input {
    flex: 0 0 auto;
  }

  .filter-tag-option-unchanged {
    border-color: var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 92%, transparent);
    color: var(--fg);
    box-shadow: none;
  }

  .filter-tag-option-enabled-pending {
    border-color: #34d399 !important;
    background: #dcfce7 !important;
    box-shadow: inset 0 0 0 1px rgba(16, 185, 129, 0.22);
    color: #065f46 !important;
  }

  .filter-tag-option-disabled-pending {
    border-color: #fb7185 !important;
    background: #ffe4e6 !important;
    box-shadow: inset 0 0 0 1px rgba(225, 29, 72, 0.16);
    color: #9f1239 !important;
  }

  .filter-tag-badge-enabled {
    background: #d1fae5;
    color: #047857;
  }

  .filter-tag-badge-disabled {
    background: #ffe4e6;
    color: #be123c;
  }

  :global(html[data-theme='dark']) .filter-tag-option-enabled-pending {
    border-color: #34d399 !important;
    background: #0b3b2e !important;
    box-shadow: inset 0 0 0 1px rgba(52, 211, 153, 0.24);
    color: #a7f3d0 !important;
  }

  :global(html[data-theme='dark']) .filter-tag-option-disabled-pending {
    border-color: #fb7185 !important;
    background: #4a1524 !important;
    box-shadow: inset 0 0 0 1px rgba(251, 113, 133, 0.22);
    color: #fecdd3 !important;
  }

  :global(html[data-theme='dark']) .filter-tag-option-unchanged {
    border-color: var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 92%, transparent);
    color: var(--fg);
  }

  :global(html[data-theme='dark']) .filter-tag-pending-indicator {
    border-color: rgba(148, 163, 184, 0.32);
    box-shadow: 0 0 0 2px rgba(15, 23, 42, 0.92);
  }

  :global(html[data-theme='dark']) .filter-tag-badge-enabled {
    background: #064e3b;
    color: #6ee7b7;
  }

  :global(html[data-theme='dark']) .filter-tag-badge-disabled {
    background: #4c1024;
    color: #fda4af;
  }
</style>
