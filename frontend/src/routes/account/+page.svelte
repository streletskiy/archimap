<script>
  import { onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { CUSTOM_MAP_ATTRIBUTION } from '$lib/constants/map';
  import {
    buildAccountEditUrl,
    buildAccountUrl,
    buildInfoUrl,
    resolveAccountEditIdFromUrl,
    resolveAccountTabFromUrl
  } from '$lib/client/section-routes';
  import {
    UiBadge,
    UiButton,
    UiDateRangePicker,
    UiInput,
    UiLabel,
    UiScrollArea,
    UiSelect,
    UiSwitch,
    UiTable,
    UiTableBody,
    UiTableCell,
    UiTableHead,
    UiTableHeader,
    UiTableRow,
    UiTabsNav
  } from '$lib/components/base';
  import { EditDetailModal, EditsIdentityCell, EditsPagination, EditsSkeletonRows } from '$lib/components/edits';
  import PortalFrame from '$lib/components/shell/PortalFrame.svelte';
  import { session, setSession } from '$lib/stores/auth';
  import { apiJson } from '$lib/services/http';
  import { getRuntimeConfig } from '$lib/services/config';
  import { loadMapRuntime, resolvePmtilesUrl } from '$lib/services/map-runtime';
  import { buildRegionLayerId, buildRegionSourceId } from '$lib/services/region-pmtiles';
  import { locale, t, translateNow } from '$lib/i18n/index';
  import { getEditsDateRangeParams } from '$lib/utils/edit-date-range';
  import { formatUiDate, getChangeCounters, getDisplayEditStatusMeta, getEditAddress, getEditKey, getSyncBadgeMeta, isOverpassBackedEdit, parseEditKey } from '$lib/utils/edit-ui';
  import { getGeometryCenter } from '$lib/utils/map-geometry';

  const LIGHT = '/styles/positron-custom.json';
  const DARK = '/styles/dark-matter-custom.json';
  const SRC = 'account-edited-points';
  const L_CLUSTER = 'account-edited-points-clusters';
  const L_COUNT = 'account-edited-points-cluster-count';
  const L_POINT = 'account-edited-points-unclustered';
  const MAP_PIN_COLOR = '#FDC82F';
  const MAP_PIN_INK = '#342700';
  const EDITS_PAGE_SIZE = 20;
  const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };

  let activeTab = resolveAccountTabFromUrl(get(page).url);
  let tabNavValue = activeTab;
  let accountUrlSyncBusy = false;
  let firstName = '';
  let lastName = '';
  let email = '';
  let currentPassword = '';
  let newPassword = '';
  let confirmNewPassword = '';
  let profileStatus = '';
  let passwordStatus = '';

  let edits = [];
  let visibleEdits = [];
  let visibleEditGroups = [];
  let editsLoading = false;
  let editsStatus;
  let editsFilter = 'all';
  let editsPage = 1;
  let editsTotal = 0;
  let editsPageCount = 0;
  let editsQuery = '';
  let editsDateRange = undefined;
  let editsFilterItems;
  let accountEditsPageInfo;
  let editsReloadTimer = null;
  let editsRequestToken = 0;
  let editsInitialLoadRequested = false;

  let selectedEdit = null;
  let selectedEditGroupItems;
  let selectedFeature = EMPTY_FEATURE_COLLECTION;
  let detailLoading = false;
  let detailStatus = '';
  let detailPaneVisible = false;
  let editActionBusy = false;
  let detailRequestToken = 0;

  let mapEl;
  let map = null;
  let maplibregl = null;
  let mapRuntimePromise = null;
  let protocol = null;
  let mapInitNonce = 0;
  let activeRegionPmtiles = [];
  const centerByKey = new Map();
  const editIdByKey = new Map();

  $: if ($session.authenticated) {
    firstName = String($session.user?.firstName || '');
    lastName = String($session.user?.lastName || '');
    email = String($session.user?.email || '');
    
    // Ensure edits are loaded if we reload directly on the edits tab 
    // and session hydrates after mount.
    if (activeTab === 'edits' && !editsLoading && edits.length === 0 && !editsInitialLoadRequested) {
      editsInitialLoadRequested = true;
      loadEdits();
    }
  }

  const msg = (e, f) => String(e?.message || f);

  function getSelectedEditId(item = selectedEdit) {
    const id = Number(item?.editId || item?.id || 0);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  function getMeaningfulEditAddress(item) {
    const address = String(getEditAddress(item) || '').trim();
    const fallback = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`;
    return address && address !== fallback ? address : '';
  }

  function getGroupDisplayAddress(group) {
    for (const item of Array.isArray(group?.edits) ? group.edits : []) {
      const address = getMeaningfulEditAddress(item);
      if (address) return address;
    }
    return getEditAddress(group?.edits?.[0] || group);
  }

  function groupEditRows(items) {
    const groups = [];
    const groupsByKey = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const key = getEditKey(item) || `edit/${Number(item?.id || item?.editId || groups.length + 1)}`;
      let group = groupsByKey.get(key);
      if (!group) {
        group = {
          key,
          osmType: item?.osmType || null,
          osmId: Number(item?.osmId || 0),
          edits: []
        };
        groupsByKey.set(key, group);
        groups.push(group);
      }
      group.edits.push(item);
    }

    return groups.map((group) => {
      const latest = group.edits[0] || null;
      return {
        ...group,
        latest,
        latestEditId: Number(latest?.id || latest?.editId || 0),
        latestCreatedAt: latest?.createdAt || null,
        latestAddress: getGroupDisplayAddress(group),
        latestCreatedBy: latest?.updatedBy || null,
        latestStatusMeta: getDisplayEditStatusMeta(latest, translateNow, 'account.edits'),
        latestCounters: getChangeCounters(latest?.changes),
        totalEdits: group.edits.length
      };
    });
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

  function ensureAccountBuildingLayers(cfg) {
    if (!map) return;
    const regions = Array.isArray(cfg?.buildingRegionsPmtiles) ? cfg.buildingRegionsPmtiles : [];
    activeRegionPmtiles = regions;

    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, cluster: true, clusterRadius: 44, clusterMaxZoom: 12 });
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
        map.addLayer({ id: fillLayerId, type: 'fill', source: sourceId, 'source-layer': region.sourceLayer, minzoom: 13, paint: { 'fill-color': '#4F4A43', 'fill-opacity': 0.25 } });
      }
      if (!map.getLayer(lineLayerId)) {
        map.addLayer({ id: lineLayerId, type: 'line', source: sourceId, 'source-layer': region.sourceLayer, minzoom: 13, paint: { 'line-color': '#2B2824', 'line-width': 2 } });
      }
    }

    if (!map.getLayer(L_CLUSTER)) map.addLayer({ id: L_CLUSTER, type: 'circle', source: SRC, filter: ['has', 'point_count'], paint: { 'circle-color': MAP_PIN_COLOR, 'circle-radius': ['step', ['get', 'point_count'], 14, 20, 18, 80, 23], 'circle-stroke-width': 2, 'circle-stroke-color': MAP_PIN_INK } });
    if (!map.getLayer(L_COUNT)) map.addLayer({ id: L_COUNT, type: 'symbol', source: SRC, filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Open Sans Bold'] }, paint: { 'text-color': MAP_PIN_INK } });
    if (!map.getLayer(L_POINT)) map.addLayer({ id: L_POINT, type: 'circle', source: SRC, filter: ['!', ['has', 'point_count']], paint: { 'circle-color': MAP_PIN_COLOR, 'circle-radius': 7, 'circle-stroke-width': 2, 'circle-stroke-color': MAP_PIN_INK } });
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
    if (count > 0 && !bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 60, duration: 450, maxZoom: 17 });
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
    const cfg = getRuntimeConfig();
    map = new maplibregl.Map({
      container: mapEl,
      style: styleByTheme(),
      center: [cfg.mapDefault.lon, cfg.mapDefault.lat],
      zoom: Math.max(12, Number(cfg.mapDefault.zoom || 14)),
      attributionControl: false
    });
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: CUSTOM_MAP_ATTRIBUTION
    }));
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.on('style.load', () => {
      ensureAccountBuildingLayers(cfg);
      applyMapData();
      fitAllEdited();
    });
    map.on('click', L_CLUSTER, (e) => {
      const f = e?.features?.[0];
      const id = Number(f?.properties?.cluster_id);
      const src = map.getSource(SRC);
      if (!Number.isInteger(id) || !src?.getClusterExpansionZoom) return;
      src.getClusterExpansionZoom(id, (err, z) => { if (!err) map.easeTo({ center: f.geometry?.coordinates || map.getCenter(), zoom: z, duration: 300 }); });
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
    for (const item of visibleEditGroups) {
      const key = item?.key || getEditKey(item);
      if (!key) continue;
      const c = centerByKey.get(key);
      if (c) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: c },
          properties: { osmKey: key, editId: Number(item.latestEditId || 0) }
        });
      }
      const p = parseEditKey(key);
      if (p) ids.push((p.osmId * 2) + (p.osmType === 'relation' ? 1 : 0));
    }
    map.getSource(SRC).setData({ type: 'FeatureCollection', features });
    for (const layerId of getEditedFillLayerIds()) {
      if (map.getLayer(layerId)) map.setFilter(layerId, ['in', ['id'], ['literal', ids]]);
    }
    for (const layerId of getEditedLineLayerIds()) {
      if (map.getLayer(layerId)) map.setFilter(layerId, ['in', ['id'], ['literal', ids]]);
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

  async function saveProfile(event) {
    event.preventDefault();
    profileStatus = translateNow('account.profileStatus.saving');
    try {
      const data = await apiJson('/api/account/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: String(firstName || '').trim(), lastName: String(lastName || '').trim() })
      });
      if (data?.user) setSession({ ...$session, user: { ...$session.user, ...data.user } });
      profileStatus = translateNow('account.profileStatus.saved');
    } catch (e) {
      profileStatus = msg(e, translateNow('account.profileStatus.saveFailed'));
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    if (!currentPassword || !newPassword) { passwordStatus = translateNow('account.security.needPasswords'); return; }
    if (newPassword !== confirmNewPassword) { passwordStatus = translateNow('account.security.mismatch'); return; }
    passwordStatus = translateNow('account.security.changing');
    try {
      await apiJson('/api/account/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      currentPassword = ''; newPassword = ''; confirmNewPassword = '';
      passwordStatus = translateNow('account.security.changed');
    } catch (e) {
      passwordStatus = msg(e, translateNow('account.security.changeFailed'));
    }
  }

  function clearEditsReloadTimer() {
    if (editsReloadTimer) {
      clearTimeout(editsReloadTimer);
      editsReloadTimer = null;
    }
  }

  function scheduleEditsReload(page = 1, delay = 250) {
    editsPage = page;
    clearEditsReloadTimer();
    editsReloadTimer = setTimeout(() => {
      editsReloadTimer = null;
      void loadEdits(page);
    }, delay);
  }

  async function loadEdits(page = editsPage) {
    const nextPage = Math.max(1, Math.trunc(Number(page) || 1));
    const requestToken = ++editsRequestToken;
    editsLoading = true;
    editsStatus = translateNow('account.edits.loading');
    try {
      const p = new URLSearchParams();
      if (editsFilter !== 'all') p.set('status', editsFilter);
      if (editsQuery.trim()) p.set('q', editsQuery.trim());
      const { from, to } = getEditsDateRangeParams(editsDateRange);
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      p.set('page', String(nextPage));
      p.set('limit', String(EDITS_PAGE_SIZE));
      const data = await apiJson(`/api/account/edits?${p.toString()}`);
      if (requestToken !== editsRequestToken) return;
      const pageCount = Math.max(0, Number(data?.pageCount || 0));
      if (pageCount > 0 && nextPage > pageCount) {
        editsPage = pageCount;
        if (requestToken === editsRequestToken) {
          await loadEdits(pageCount);
        }
        return;
      }
      edits = Array.isArray(data?.items) ? data.items : [];
      visibleEdits = [...edits];
      editsTotal = Math.max(0, Number(data?.total || 0));
      editsPageCount = Math.max(0, pageCount || (editsTotal > 0 ? Math.ceil(editsTotal / EDITS_PAGE_SIZE) : 0));
      editsPage = Number.isInteger(Number(data?.page)) && Number(data.page) > 0 ? Number(data.page) : nextPage;
      visibleEditGroups = groupEditRows(visibleEdits);
      await loadCenters(visibleEdits);
      await ensureMap();
      applyMapData();
      fitAllEdited();
      editsStatus = visibleEditGroups.length
        ? translateNow('account.edits.statusShownGrouped', { visible: visibleEditGroups.length, total: editsTotal })
        : translateNow('account.edits.statusEmpty');
    } catch (e) {
      edits = [];
      visibleEdits = [];
      visibleEditGroups = [];
      editsTotal = 0;
      editsPageCount = 0;
      editsStatus = msg(e, translateNow('account.edits.loadFailed'));
    } finally {
      if (requestToken === editsRequestToken) {
        editsLoading = false;
      }
    }
  }

  async function openEdit(editId, { syncUrl = true } = {}) {
    const id = Number(editId);
    if (!Number.isInteger(id) || id <= 0) return;
    const requestToken = ++detailRequestToken;
    detailPaneVisible = true;
    detailLoading = true;
    editActionBusy = false;
    detailStatus = translateNow('account.edits.loading');
    selectedEdit = null;
    selectedFeature = EMPTY_FEATURE_COLLECTION;
    try {
      const data = await apiJson(`/api/account/edits/${id}`);
      if (requestToken !== detailRequestToken) return;
      selectedEdit = data?.item || null;
      if (!selectedEdit) {
        detailStatus = translateNow('account.edits.detailsLoadFailed');
        return;
      }
      detailStatus = '';
      if (syncUrl) {
        await replaceAccountUrl(activeTab, id);
      }
      try {
        const feature = await apiJson(`/api/building/${encodeURIComponent(selectedEdit.osmType)}/${encodeURIComponent(selectedEdit.osmId)}`);
        if (requestToken !== detailRequestToken) return;
        selectedFeature = feature && typeof feature === 'object' ? feature : EMPTY_FEATURE_COLLECTION;
      } catch {
        selectedFeature = EMPTY_FEATURE_COLLECTION;
      }
    } catch (e) {
      if (requestToken !== detailRequestToken) return;
      detailStatus = msg(e, translateNow('account.edits.detailsLoadFailed'));
      selectedEdit = null;
      selectedFeature = EMPTY_FEATURE_COLLECTION;
    } finally {
      if (requestToken === detailRequestToken) detailLoading = false;
    }
  }

  async function cancelSelectedEdit() {
    const id = getSelectedEditId();
    if (!id || !selectedEdit || selectedEdit.status !== 'pending' || editActionBusy) return;

    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(
        translateNow('account.edits.cancelPendingConfirm', { id })
      );
      if (!confirmed) return;
    }

    editActionBusy = true;
    detailStatus = translateNow('account.edits.cancelPendingWorking');
    try {
      await apiJson(`/api/account/edits/${id}`, {
        method: 'DELETE'
      });
      selectedEdit = null;
      selectedFeature = EMPTY_FEATURE_COLLECTION;
      detailLoading = false;
      detailStatus = translateNow('account.edits.cancelPendingSuccess');
      if (activeTab === 'edits') {
        await replaceAccountUrl(activeTab, null);
        await loadEdits();
      }
    } catch (e) {
      detailStatus = msg(e, translateNow('account.edits.cancelPendingFailed'));
    } finally {
      editActionBusy = false;
    }
  }

  function closeEditPanel(options = {}) {
    const { syncUrl = true } = options;
    detailRequestToken += 1;
    detailPaneVisible = false;
    selectedEdit = null;
    selectedFeature = EMPTY_FEATURE_COLLECTION;
    detailLoading = false;
    detailStatus = '';
    editActionBusy = false;
    if (syncUrl && activeTab === 'edits') {
      void replaceAccountUrl(activeTab, null);
    }
  }

  function resetEditPanelState() {
    closeEditPanel({ syncUrl: false });
  }


  async function replaceAccountUrl(tab, editId = null) {
    if (typeof window === 'undefined') return;
    const next = Number.isInteger(Number(editId)) && Number(editId) > 0 && tab === 'edits'
      ? buildAccountEditUrl(window.location.href, editId)
      : buildAccountUrl(window.location.href, tab);
    if (!(Number.isInteger(Number(editId)) && Number(editId) > 0 && tab === 'edits')) {
      next.searchParams.delete('editId');
    }
    const current = new URL(window.location.href);
    if (next.toString() === current.toString()) return;
    accountUrlSyncBusy = true;
    try {
      await goto(`${next.pathname}${next.search}${next.hash}`, {
        replaceState: true,
        keepFocus: true,
        noScroll: true
      });
    } finally {
      queueMicrotask(() => {
        accountUrlSyncBusy = false;
      });
    }
  }

  async function activateTab(tab) {
    if (activeTab === tab) return;
    activeTab = tab;
    tabNavValue = tab;
    await tick();
    if (tab === 'edits') {
      await ensureMap();
      map?.resize();
      applyMapData();
      fitAllEdited();
      if (!edits.length && !editsLoading && !editsInitialLoadRequested) {
        editsInitialLoadRequested = true;
        await loadEdits();
      }
      return;
    }
    resetEditPanelState();
    destroyMap();
  }

  async function switchTab(tab) {
    if (activeTab === tab) {
      await replaceAccountUrl(tab, tab === 'edits' ? getSelectedEditId() : null);
      return;
    }
    await activateTab(tab);
    await replaceAccountUrl(tab, tab === 'edits' ? getSelectedEditId() : null);
  }

  async function handleTabNavChange(event) {
    const nextTab = String(event.detail?.value || '').trim();
    if (!nextTab) {
      tabNavValue = activeTab;
      return;
    }
    await switchTab(nextTab);
  }

  $: {
    visibleEdits = Array.isArray(edits) ? edits : [];
    visibleEditGroups = groupEditRows(visibleEdits);
    const groupedEdits = visibleEditGroups;
    const selectedKey = getEditKey(selectedEdit);
    selectedEditGroupItems = selectedKey
      ? (groupedEdits.find((group) => group.key === selectedKey)?.edits || (selectedEdit ? [selectedEdit] : []))
      : (selectedEdit ? [selectedEdit] : []);
    editIdByKey.clear();
    for (const group of visibleEditGroups) {
      if (group.latestEditId) editIdByKey.set(group.key, group.latestEditId);
    }
    if (map) {
      applyMapData();
      fitAllEdited();
    }
  }

  $: accountEditsPageInfo = editsPageCount > 0 ? $t('account.edits.pageInfo', { page: editsPage, pages: editsPageCount }) : '';
  $: editsFilterItems = [
    { value: 'all', label: $t('account.edits.filterAll') },
    { value: 'pending', label: $t('account.edits.filterPending') },
    { value: 'accepted', label: $t('account.edits.filterAccepted') },
    { value: 'partially_accepted', label: $t('account.edits.filterPartiallyAccepted') },
    { value: 'rejected', label: $t('account.edits.filterRejected') },
    { value: 'superseded', label: $t('account.edits.filterSuperseded') }
  ];
  onMount(() => {
    const unsubscribePage = page.subscribe(($pageState) => {
      if (accountUrlSyncBusy) return;
      const nextTab = resolveAccountTabFromUrl($pageState.url);
      const nextEditId = resolveAccountEditIdFromUrl($pageState.url);
      void (async () => {
        tabNavValue = nextTab;
        await activateTab(nextTab);
        if (nextTab === 'edits') {
          if (nextEditId) {
            const currentEditId = getSelectedEditId();
            if (currentEditId !== nextEditId || !detailPaneVisible || detailLoading) {
              await openEdit(nextEditId, { syncUrl: false });
            }
          } else if (detailPaneVisible || detailLoading || Boolean(selectedEdit) || Boolean(detailStatus)) {
            closeEditPanel({ syncUrl: false });
          }
        }
        await replaceAccountUrl(nextTab, nextTab === 'edits' ? nextEditId : null);
      })();
    });
    if (activeTab === 'edits') {
      ensureMap();
      if ($session.authenticated && !editsLoading && edits.length === 0 && !editsInitialLoadRequested) {
        editsInitialLoadRequested = true;
        loadEdits();
      }
    }
    const obs = new MutationObserver(() => { if (map) map.setStyle(styleByTheme()); });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      unsubscribePage();
      obs.disconnect();
      destroyMap();
    };
  });
</script>

{#if !$session.authenticated}
  <PortalFrame title={$t('account.title')} description={$t('account.subtitle')}>
    <div class="portal-notice">
      <h2 class="text-xl font-extrabold ui-text-strong">{$t('account.authRequiredTitle')}</h2>
      <p class="mt-2 text-sm ui-text-muted">{$t('account.authRequiredText')}</p>
    </div>
  </PortalFrame>
{:else}
  <PortalFrame title={$t('account.title')} description={$t('account.subtitle')}>
    <svelte:fragment slot="meta">
      <UiBadge variant="default"><strong>{$t('account.profile.email')}</strong>{email || '-'}</UiBadge>
      <UiBadge variant="accent"><strong>{$t('account.tabs.edits')}</strong>{editsTotal}</UiBadge>
    </svelte:fragment>

    <UiTabsNav
      bind:value={tabNavValue}
      items={[
        { value: 'settings', label: $t('account.tabs.settings') },
        { value: 'edits', label: $t('account.tabs.edits') }
      ]}
      onchange={handleTabNavChange}
    />
    {#if activeTab === 'settings'}
      <div class="mt-4 grid gap-4 xl:grid-cols-3">
          <section class="rounded-2xl border ui-border ui-surface-muted p-4">
            <h3 class="text-base font-bold ui-text-strong">{$t('account.profile.title')}</h3>
            <form class="mt-4 grid gap-4" on:submit={saveProfile}>
              <div class="grid gap-1.5">
                <UiLabel for="account-first-name">{$t('account.profile.firstName')}</UiLabel>
                <UiInput id="account-first-name" bind:value={firstName} />
              </div>
              <div class="grid gap-1.5">
                <UiLabel for="account-last-name">{$t('account.profile.lastName')}</UiLabel>
                <UiInput id="account-last-name" bind:value={lastName} />
              </div>
              <div class="grid gap-1.5">
                <UiLabel for="account-email">{$t('account.profile.email')}</UiLabel>
                <UiInput id="account-email" value={email} readonly className="ui-text-subtle" />
              </div>
              <UiButton type="submit">{$t('account.profile.save')}</UiButton>
            </form>
            {#if profileStatus}
              <p class="mt-3 text-sm ui-text-muted">{profileStatus}</p>
            {/if}
          </section>
          <section class="rounded-2xl border ui-border ui-surface-muted p-4">
            <h3 class="text-base font-bold ui-text-strong">{$t('account.security.title')}</h3>
            <form class="mt-4 grid gap-4" on:submit={changePassword}>
              <div class="grid gap-1.5">
                <UiLabel for="account-current-password">{$t('account.security.currentPassword')}</UiLabel>
                <UiInput
                  id="account-current-password"
                  type="password"
                  bind:value={currentPassword}
                  autocomplete="current-password"
                  required
                />
              </div>
              <div class="grid gap-1.5">
                <UiLabel for="account-new-password">{$t('account.security.newPassword')}</UiLabel>
                <UiInput
                  id="account-new-password"
                  type="password"
                  bind:value={newPassword}
                  autocomplete="new-password"
                  required
                />
              </div>
              <div class="grid gap-1.5">
                <UiLabel for="account-confirm-password">{$t('account.security.repeatPassword')}</UiLabel>
                <UiInput
                  id="account-confirm-password"
                  type="password"
                  bind:value={confirmNewPassword}
                  autocomplete="new-password"
                  required
                />
              </div>
              <UiButton type="submit" variant="outline">{$t('account.security.change')}</UiButton>
            </form>
            {#if passwordStatus}
              <p class="mt-3 text-sm ui-text-muted">{passwordStatus}</p>
            {/if}
          </section>
          <section class="rounded-2xl border ui-border ui-surface-muted p-4">
            <h3 class="text-base font-bold ui-text-strong">{$t('account.notifications.title')}</h3>
            <div class="mt-4 space-y-4">
              <div class="flex items-start justify-between gap-3 rounded-2xl border ui-border ui-surface-base p-4">
                <div>
                  <p class="text-sm font-semibold ui-text-strong">{$t('account.notifications.commentsTitle')}</p>
                  <p class="mt-1 text-sm ui-text-subtle">{$t('account.notifications.commentsText')}</p>
                </div>
                <UiSwitch checked={false} disabled aria-label={$t('account.notifications.commentsTitle')} />
              </div>
              <div class="flex items-start justify-between gap-3 rounded-2xl border ui-border ui-surface-base p-4">
                <div>
                  <p class="text-sm font-semibold ui-text-strong">{$t('account.notifications.moderationTitle')}</p>
                  <p class="mt-1 text-sm ui-text-subtle">{$t('account.notifications.moderationText')}</p>
                </div>
                <UiSwitch checked={false} disabled aria-label={$t('account.notifications.moderationTitle')} />
              </div>
              <div class="flex items-start justify-between gap-3 rounded-2xl border ui-border ui-surface-base p-4">
                <div>
                  <p class="text-sm font-semibold ui-text-strong">{$t('account.notifications.weeklyTitle')}</p>
                  <p class="mt-1 text-sm ui-text-subtle">{$t('account.notifications.weeklyText')}</p>
                </div>
                <UiSwitch checked={false} disabled aria-label={$t('account.notifications.weeklyTitle')} />
              </div>
            </div>
          </section>
          <section class="rounded-2xl border ui-border ui-surface-muted p-4">
            <h3 class="text-base font-bold ui-text-strong">{$t('account.legal.title')}</h3>
            <p class="mt-1 text-sm ui-text-muted">{$t('account.legal.text')}</p>
            <div class="mt-4 space-y-2">
              <a href={buildInfoUrl($page.url, 'agreement').pathname} class="block rounded-xl border ui-border ui-surface-base px-3 py-2 text-sm font-semibold ui-text-body underline underline-offset-2 ui-hover-surface">{$t('account.legal.terms')}</a>
              <a href={buildInfoUrl($page.url, 'privacy').pathname} class="block rounded-xl border ui-border ui-surface-base px-3 py-2 text-sm font-semibold ui-text-body underline underline-offset-2 ui-hover-surface">{$t('account.legal.privacy')}</a>
            </div>
          </section>
      </div>
  {:else}
      <div class="mt-4 grid gap-4 overflow-hidden min-h-0">
        <section class="flex flex-col space-y-3 rounded-2xl border ui-border ui-surface-base p-3 min-h-0 overflow-hidden">
          <div class="ui-filter-toolbar ui-filter-toolbar--account-edits">
            <UiInput
              type="search"
              placeholder={$t('account.edits.searchPlaceholder')}
              bind:value={editsQuery}
              oninput={() => scheduleEditsReload(1)}
            />
            <UiDateRangePicker
              value={editsDateRange}
              locale={$locale}
              placeholder={$t('account.edits.dateRangePlaceholder')}
              calendarLabel={$t('account.edits.dateRangeLabel')}
              clearLabel={$t('common.clear')}
              onchange={(event) => {
                editsDateRange = event.detail.value;
                if (!event.detail.value?.start || event.detail.value?.end) {
                  scheduleEditsReload(1, 0);
                }
              }}
            />
            <UiSelect items={editsFilterItems} bind:value={editsFilter} onchange={() => loadEdits(1)} />
            <UiButton
              type="button"
              variant="secondary"
              className="w-full min-h-11 rounded-[1rem] px-4 py-3 text-sm sm:w-auto"
              onclick={() => loadEdits(editsPage)}
            >
              {$t('common.refresh')}
            </UiButton>
          </div>
          <p class="text-sm ui-text-muted">{editsStatus}</p>
          <div class="h-[36vh] min-h-[260px] flex-shrink-0 overflow-hidden rounded-xl border ui-border" bind:this={mapEl}></div>
          <UiScrollArea className="ui-scroll-surface flex-1 min-h-0 rounded-xl">
            <UiTable
              framed={false}
              className="ui-table--mobile-wide [--ui-table-mobile-min-width:52rem] [--ui-table-mobile-identity-width:20rem]"
            >
            <UiTableHeader>
              <UiTableRow className="hover:[&>th]:bg-transparent">
                <UiTableHead>{$t('account.edits.tableObject')}</UiTableHead>
                <UiTableHead>{$t('account.edits.tableAuthor')}</UiTableHead>
                <UiTableHead>{$t('account.edits.tableCreatedAt')}</UiTableHead>
                <UiTableHead>{$t('account.edits.tableStatus')}</UiTableHead>
                <UiTableHead>{$t('account.edits.tableChanges')}</UiTableHead>
              </UiTableRow>
            </UiTableHeader>
            <UiTableBody>
              {#if editsLoading}
                <EditsSkeletonRows rows={EDITS_PAGE_SIZE} idLabel={$t('account.edits.id')} />
              {:else if visibleEditGroups.length===0}
                <UiTableRow>
                  <UiTableCell colspan="5" className="ui-text-subtle">{$t('account.edits.empty')}</UiTableCell>
                </UiTableRow>
              {:else}
                {#each visibleEditGroups as group (group.key)}
                  {@const statusMeta = group.latestStatusMeta}
                  {@const counters = group.latestCounters}
                  <UiTableRow
                    className="cursor-pointer hover:[&>td]:[background:color-mix(in_srgb,var(--accent-soft)_44%,var(--panel-solid))]"
                    onclick={() => openEdit(group.latestEditId || group.edits?.[0]?.id || group.edits?.[0]?.editId)}
                  >
                    <UiTableCell className="edits-list-identity-cell min-w-0">
                      <EditsIdentityCell
                        idLabel={$t('account.edits.id')}
                        osmType={group.osmType}
                        osmId={group.osmId}
                        address={group.latestAddress}
                        markerText={group.totalEdits > 1 ? `×${group.totalEdits}` : ''}
                        markerTitle={group.totalEdits > 1 ? $t('account.edits.groupTitle') : ''}
                        showBadgesRow={Boolean(group.latest?.orphaned || (group.latest && !group.latest.osmPresent && !group.latest.orphaned) || group.latest?.sourceOsmChanged)}
                      >
                        <svelte:fragment slot="badges">
                        {@const overpassBacked = isOverpassBackedEdit(group.latest)}
                        {#if group.latest?.orphaned}
                          <span class="rounded-md ui-surface-danger px-2 py-1 text-[11px] font-semibold ui-text-danger">{$t('account.edits.orphaned')}</span>
                        {:else if overpassBacked}
                          <span class="rounded-md ui-surface-info px-2 py-1 text-[11px] font-semibold ui-text-info">{$t('account.edits.overpassSource')}</span>
                        {:else if group.latest && !group.latest.osmPresent && !group.latest.orphaned}
                          <span class="rounded-md ui-surface-warning px-2 py-1 text-[11px] font-semibold ui-text-warning">{$t('account.edits.missingTarget')}</span>
                        {/if}
                        {#if group.latest?.sourceOsmChanged}
                          <span class="rounded-md ui-surface-info px-2 py-1 text-[11px] font-semibold ui-text-info">{$t('account.edits.osmChanged')}</span>
                        {/if}
                        </svelte:fragment>
                      </EditsIdentityCell>
                    </UiTableCell>
                    <UiTableCell>{group.latestCreatedBy || '-'}</UiTableCell>
                    <UiTableCell>
                      <span class="whitespace-nowrap text-xs ui-text-subtle">{formatUiDate(group.latestCreatedAt) || '-'}</span>
                    </UiTableCell>
                    <UiTableCell>
                      <span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {statusMeta.cls}">{statusMeta.text}</span>
                    </UiTableCell>
                    <UiTableCell>
                      <div class="edits-list-changes flex flex-wrap items-center gap-2">
                        <span class="rounded-md ui-surface-soft px-2 py-1 text-xs ui-text-muted">{counters.total} {$t('account.edits.total')}</span>
                        {#if counters.created > 0}
                          <span class="rounded-md ui-surface-success-soft px-2 py-1 text-xs ui-text-success-soft">+{counters.created} {$t('account.edits.created')}</span>
                        {/if}
                        {#if counters.modified > 0}
                          <span class="rounded-md ui-surface-emphasis px-2 py-1 text-xs ui-text-body">~{counters.modified} {$t('account.edits.modified')}</span>
                        {/if}
                      </div>
                    </UiTableCell>
                  </UiTableRow>
                {/each}
              {/if}
            </UiTableBody>
          </UiTable>
          </UiScrollArea>
          <EditsPagination
            page={editsPage}
            pageCount={editsPageCount}
            pageInfo={accountEditsPageInfo}
            loading={editsLoading}
            previousLabel={$t('common.previous')}
            nextLabel={$t('common.next')}
            onPageChange={loadEdits}
          />
        </section>
        {#if detailPaneVisible}
          <EditDetailModal
            open={detailPaneVisible}
            title={$t('account.edits.detailTitle')}
            closeLabel={$t('account.edits.closeDetail')}
            closeDisabled={editActionBusy}
            selectedFeature={selectedFeature}
            mapLoading={detailLoading}
            mapLoadingText={$t('account.edits.loading')}
            onClose={closeEditPanel}
          >
            <div class="edit-detail-flow">
              {#if detailLoading}
                <p class="text-sm ui-text-subtle">{$t('account.edits.loading')}</p>
              {:else if !selectedEdit && detailStatus}
                <p class="text-sm ui-text-muted">{detailStatus}</p>
              {:else if !selectedEdit}
                <p class="text-sm ui-text-subtle">{$t('account.edits.selectHint')}</p>
              {:else}
                {@const selectedStatusMeta = getDisplayEditStatusMeta(selectedEdit, translateNow, 'account.edits')}
                <p class="edit-detail-meta flex flex-wrap items-center gap-2 text-sm ui-text-muted">
                  <span class="edit-detail-meta-primary">{$t('account.edits.id')}: {selectedEdit.editId || selectedEdit.id} | {selectedEdit.osmType}/{selectedEdit.osmId}</span>
                  {#if selectedEdit.syncChangesetId && selectedEditGroupItems.length <= 1}
                    <span>{$t('account.edits.syncChangeset')}: #{selectedEdit.syncChangesetId}</span>
                  {/if}
                  <span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {selectedStatusMeta.cls}">{selectedStatusMeta.text}</span>
                </p>
                {#if selectedEdit.status === 'pending'}
                  <div class="rounded-xl border ui-border ui-surface-warning p-3 text-sm ui-text-body">
                    <p class="text-sm font-semibold ui-text-strong">{$t('account.edits.pendingEditTitle')}</p>
                    <p class="mt-1 text-sm ui-text-subtle">{$t('account.edits.pendingEditHelp')}</p>
                    <div class="mt-3 flex flex-wrap gap-2">
                      <UiButton
                        type="button"
                        variant="danger"
                        size="sm"
                        disabled={editActionBusy}
                        onclick={cancelSelectedEdit}
                      >
                        {editActionBusy ? $t('account.edits.cancelPendingWorking') : $t('account.edits.cancelPending')}
                      </UiButton>
                    </div>
                  </div>
                {/if}
                {#if selectedEdit.syncStatus && selectedEdit.syncStatus !== 'unsynced'}
                  <div class="rounded-xl border ui-border ui-surface-muted p-3 text-sm ui-text-body">
                    <p><strong>{$t('account.edits.syncStatus')}:</strong> {getSyncBadgeMeta(selectedEdit.syncStatus, translateNow, 'account.edits').text}</p>
                    <p><strong>{$t('account.edits.syncAttemptedAt')}:</strong> {formatUiDate(selectedEdit.syncAttemptedAt) || '---'}</p>
                    <p><strong>{$t('account.edits.syncSucceededAt')}:</strong> {formatUiDate(selectedEdit.syncSucceededAt) || '---'}</p>
                    <p><strong>{$t('account.edits.syncCleanedAt')}:</strong> {formatUiDate(selectedEdit.syncCleanedAt) || '---'}</p>
                    {#if selectedEdit.syncSummary}
                      <p class="edit-detail-break mt-1 text-xs ui-text-subtle">{JSON.stringify(selectedEdit.syncSummary)}</p>
                    {/if}
                    {#if selectedEdit.syncError}
                      <p class="edit-detail-break mt-1 text-xs ui-text-danger">{selectedEdit.syncError}</p>
                    {/if}
                  </div>
                {/if}
                {#if selectedEditGroupItems.length > 1}
                  <div class="rounded-xl border ui-border ui-surface-soft p-3 text-sm ui-text-body">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <p class="text-sm font-semibold ui-text-strong">{$t('account.edits.groupTitle')}</p>
                      <span class="rounded-md ui-surface-soft px-2 py-1 text-[11px] font-semibold ui-text-muted">×{selectedEditGroupItems.length}</span>
                    </div>
                    <div class="mt-2 space-y-2">
                      {#each selectedEditGroupItems as groupEdit (`group-edit-${groupEdit.id || groupEdit.editId}`)}
                        {@const groupStatusMeta = getDisplayEditStatusMeta(groupEdit, translateNow, 'account.edits')}
                        {@const groupCounters = getChangeCounters(groupEdit.changes)}
                        <div class="rounded-lg border ui-border ui-surface-base p-2">
                          <div class="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <p class="text-sm font-semibold ui-text-strong">#{groupEdit.editId || groupEdit.id}</p>
                              <p class="text-xs ui-text-subtle">{formatUiDate(groupEdit.createdAt || groupEdit.updatedAt) || '---'}</p>
                            </div>
                            <span class={`badge-pill rounded-full px-2.5 py-1 text-xs font-semibold ${groupStatusMeta.cls}`}>{groupStatusMeta.text}</span>
                          </div>
                          <div class="mt-1 space-y-1 text-xs ui-text-muted">
                            {#if groupEdit.syncChangesetId}
                              <p><strong>{$t('account.edits.syncChangeset')}:</strong> #{groupEdit.syncChangesetId}</p>
                            {/if}
                            {#if String(groupEdit.adminComment || '').trim()}
                              <p class="edit-detail-break ui-text-danger"><strong>{$t('account.edits.comment')}:</strong> {String(groupEdit.adminComment).trim()}</p>
                            {/if}
                            <p><strong>{$t('account.edits.tableChanges')}:</strong> {groupCounters.total} {$t('account.edits.total')}</p>
                          </div>
                          <div class="mt-2 space-y-1">
                            {#if !Array.isArray(groupEdit.changes) || groupEdit.changes.length === 0}
                              <p class="text-xs ui-text-subtle">{$t('account.edits.noChanges')}</p>
                            {:else}
                              {#each groupEdit.changes as ch (`${groupEdit.id || groupEdit.editId}-${ch.field}`)}
                                <div class="rounded-md border ui-border ui-surface-muted p-2">
                                  <p class="text-sm font-semibold ui-text-strong">{ch.label || ch.field}</p>
                                  <p class="edit-detail-break text-xs ui-text-muted">
                                    <span class="line-through">{String(ch.osmValue ?? $t('account.edits.emptyValue'))}</span>
                                    -> <strong>{String(ch.localValue ?? $t('account.edits.emptyValue'))}</strong>
                                  </p>
                                </div>
                              {/each}
                            {/if}
                          </div>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}
                {@const overpassBacked = isOverpassBackedEdit(selectedEdit)}
                {#if overpassBacked}
                  <div class="rounded-xl border ui-border ui-surface-info p-3 text-sm ui-text-body">
                    <p class="font-semibold ui-text-info">{$t('account.edits.overpassSource')}</p>
                    <p class="mt-1 text-xs ui-text-muted">{$t('account.edits.overpassSourceHelp')}</p>
                  </div>
                {/if}
                {#if selectedEdit.orphaned || (!selectedEdit.osmPresent && !selectedEdit.orphaned && !overpassBacked) || selectedEdit.sourceOsmChanged}
                  <div class="space-y-2 rounded-xl border p-3 text-sm" style="border-color: var(--ui-map-filter-warning-border); background: var(--ui-map-filter-warning-bg); color: var(--ui-map-filter-warning-text)">
                    {#if selectedEdit.orphaned}
                      <p>{$t('account.edits.orphanedHelp')}</p>
                    {/if}
                    {#if !selectedEdit.osmPresent && !selectedEdit.orphaned && !overpassBacked}
                      <p>{$t('account.edits.missingTargetHelp')}</p>
                    {/if}
                    {#if selectedEdit.sourceOsmChanged}
                      <p>{$t('account.edits.osmChangedHelp')}</p>
                    {/if}
                  </div>
                {/if}
                {#if selectedEditGroupItems.length <= 1}
                  <div class="space-y-2">
                    {#if !Array.isArray(selectedEdit.changes) || selectedEdit.changes.length === 0}
                      <p class="text-sm ui-text-subtle">{$t('account.edits.noChanges')}</p>
                    {:else}
                      {#each selectedEdit.changes as ch (`${ch.field}`)}
                        <div class="rounded-lg border ui-border ui-surface-muted p-2">
                          <p class="text-sm font-semibold ui-text-strong">{ch.label || ch.field}</p>
                          <p class="edit-detail-break text-xs ui-text-muted">
                            <span class="line-through">{String(ch.osmValue ?? $t('account.edits.emptyValue'))}</span>
                            -> <strong>{String(ch.localValue ?? $t('account.edits.emptyValue'))}</strong>
                          </p>
                        </div>
                      {/each}
                    {/if}
                  </div>
                {/if}
                {#if detailStatus}
                  <p class="text-sm ui-text-muted">{detailStatus}</p>
                {/if}
              {/if}
            </div>
          </EditDetailModal>
        {/if}
      </div>
    {/if}
  </PortalFrame>
{/if}

