<script>
  import { onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { fade } from 'svelte/transition';
  import { CUSTOM_MAP_ATTRIBUTION } from '$lib/constants/map';
  import { buildAccountUrl, buildInfoUrl, resolveAccountTabFromUrl } from '$lib/client/section-routes';
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
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import PortalFrame from '$lib/components/shell/PortalFrame.svelte';
  import { session, setSession } from '$lib/stores/auth';
  import { apiJson } from '$lib/services/http';
  import { getRuntimeConfig } from '$lib/services/config';
  import { loadMapRuntime, resolvePmtilesUrl } from '$lib/services/map-runtime';
  import { buildRegionLayerId, buildRegionSourceId } from '$lib/services/region-pmtiles';
  import { locale, t, translateNow } from '$lib/i18n/index';
  import { formatUiDate, getChangeCounters, getEditAddress, getEditKey, getStatusBadgeMeta, matchesUiDateRange, parseEditKey } from '$lib/utils/edit-ui';
  import { focusMapOnGeometry, getGeometryCenter } from '$lib/utils/map-geometry';

  const LIGHT = '/styles/positron-custom.json';
  const DARK = '/styles/dark-matter-custom.json';
  const SRC = 'account-edited-points';
  const L_CLUSTER = 'account-edited-points-clusters';
  const L_COUNT = 'account-edited-points-cluster-count';
  const L_POINT = 'account-edited-points-unclustered';
  const MAP_PIN_COLOR = '#FDC82F';
  const MAP_PIN_INK = '#342700';

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
  let editsLoading = false;
  let editsStatus = translateNow('account.edits.loading');
  let editsFilter = 'all';
  let editsLimit = 200;
  let editsQuery = '';
  let editsDateRange = undefined;
  let editsFilterItems = [];
  const editsLimitItems = [
    { value: 100, label: '100' },
    { value: 200, label: '200' },
    { value: 500, label: '500' }
  ];

  let selectedEdit = null;
  let detailLoading = false;
  let detailStatus = '';
  let detailPaneVisible = false;
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
  }

  const msg = (e, f) => String(e?.message || f);

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

    if (!map.getSource('selected-building')) {
      map.addSource('selected-building', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
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

    if (!map.getLayer('selected-fill')) map.addLayer({ id: 'selected-fill', type: 'fill', source: 'selected-building', paint: { 'fill-color': '#4F4A43', 'fill-opacity': 0.2 } });
    if (!map.getLayer('selected-line')) map.addLayer({ id: 'selected-line', type: 'line', source: 'selected-building', paint: { 'line-color': '#2B2824', 'line-width': 3 } });
    if (!map.getLayer(L_CLUSTER)) map.addLayer({ id: L_CLUSTER, type: 'circle', source: SRC, filter: ['has', 'point_count'], paint: { 'circle-color': MAP_PIN_COLOR, 'circle-radius': ['step', ['get', 'point_count'], 14, 20, 18, 80, 23], 'circle-stroke-width': 2, 'circle-stroke-color': MAP_PIN_INK } });
    if (!map.getLayer(L_COUNT)) map.addLayer({ id: L_COUNT, type: 'symbol', source: SRC, filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Open Sans Bold'] }, paint: { 'text-color': MAP_PIN_INK } });
    if (!map.getLayer(L_POINT)) map.addLayer({ id: L_POINT, type: 'circle', source: SRC, filter: ['!', ['has', 'point_count']], paint: { 'circle-color': MAP_PIN_COLOR, 'circle-radius': 7, 'circle-stroke-width': 2, 'circle-stroke-color': MAP_PIN_INK } });
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
    for (const item of visibleEdits) {
      const key = getEditKey(item);
      if (!key) continue;
      const c = centerByKey.get(key);
      if (c) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { osmKey: key, editId: Number(item.id || item.editId || 0) } });
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

  async function loadEdits() {
    editsLoading = true;
    editsStatus = translateNow('account.edits.loading');
    try {
      const p = new URLSearchParams();
      if (editsFilter !== 'all') p.set('status', editsFilter);
      p.set('limit', String(editsLimit));
      const data = await apiJson(`/api/account/edits?${p.toString()}`);
      edits = Array.isArray(data?.items) ? data.items : [];
      visibleEdits = [...edits];
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
        ? translateNow('account.edits.statusShown', { visible: visibleEdits.length, total: edits.length })
        : translateNow('account.edits.statusEmpty');
    } catch (e) {
      edits = [];
      editsStatus = msg(e, translateNow('account.edits.loadFailed'));
    } finally {
      editsLoading = false;
    }
  }

  async function openEdit(editId) {
    const id = Number(editId);
    if (!Number.isInteger(id) || id <= 0) return;
    const requestToken = ++detailRequestToken;
    detailPaneVisible = true;
    detailLoading = true;
    detailStatus = translateNow('account.edits.loading');
    selectedEdit = null;
    try {
      const data = await apiJson(`/api/account/edits/${id}`);
      if (requestToken !== detailRequestToken) return;
      selectedEdit = data?.item || null;
      detailStatus = '';
      try {
        const feature = await apiJson(`/api/building/${encodeURIComponent(selectedEdit.osmType)}/${encodeURIComponent(selectedEdit.osmId)}`);
        if (requestToken !== detailRequestToken) return;
        if (map?.getSource('selected-building')) map.getSource('selected-building').setData(feature);
        focusMapOnFeature(feature);
      } catch {}
    } catch (e) {
      if (requestToken !== detailRequestToken) return;
      detailStatus = msg(e, translateNow('account.edits.detailsLoadFailed'));
      selectedEdit = null;
    } finally {
      if (requestToken === detailRequestToken) detailLoading = false;
    }
  }

  function closeEditPanel() {
    detailRequestToken += 1;
    detailPaneVisible = false;
  }

  function resetEditPanelState() {
    detailRequestToken += 1;
    detailPaneVisible = false;
    selectedEdit = null;
    detailLoading = false;
    detailStatus = '';
    if (map?.getSource('selected-building')) {
      map.getSource('selected-building').setData({ type: 'FeatureCollection', features: [] });
    }
  }

  function onDetailPaneOutroEnd() {
    if (detailPaneVisible) return;
    selectedEdit = null;
    detailLoading = false;
    detailStatus = '';
    if (map?.getSource('selected-building')) {
      map.getSource('selected-building').setData({ type: 'FeatureCollection', features: [] });
    }
  }

  function getSyncBadgeMeta(status) {
    const normalized = String(status || 'unsynced').trim().toLowerCase();
    if (normalized === 'synced') return { cls: 'ui-surface-success-soft ui-text-success-soft', text: $t('account.edits.syncSynced') };
    if (normalized === 'cleaned') return { cls: 'ui-surface-info ui-text-info', text: $t('account.edits.syncCleaned') };
    if (normalized === 'syncing') return { cls: 'ui-surface-warning ui-text-warning', text: $t('account.edits.syncing') };
    if (normalized === 'failed') return { cls: 'ui-surface-danger ui-text-danger', text: $t('account.edits.syncFailed') };
    return { cls: 'ui-surface-soft ui-text-muted', text: $t('account.edits.syncUnsynced') };
  }

  async function replaceAccountUrl(tab) {
    if (typeof window === 'undefined') return;
    const next = buildAccountUrl(window.location.href, tab);
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
      if (!edits.length && !editsLoading) await loadEdits();
      return;
    }
    resetEditPanelState();
    destroyMap();
  }

  async function switchTab(tab) {
    await activateTab(tab);
    await replaceAccountUrl(tab);
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
    const q = String(editsQuery || '').trim().toLowerCase();
    visibleEdits = edits.filter((item) => {
      const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`.toLowerCase();
      const address = getEditAddress(item).toLowerCase();
      if (q && !address.includes(q) && !osmKey.includes(q)) return false;
      if (!matchesUiDateRange(item?.updatedAt, editsDateRange)) return false;
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
      ? translateNow('account.edits.loading')
      : translateNow('account.edits.statusShown', { visible: visibleEdits.length, total: edits.length });
  }

  $: accountPaneOpen = detailPaneVisible || detailLoading || Boolean(selectedEdit) || Boolean(detailStatus);
  $: accountUserLabel = `${String(firstName || '').trim()} ${String(lastName || '').trim()}`.trim() || String(email || '').trim() || '-';
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
      void (async () => {
        tabNavValue = nextTab;
        await activateTab(nextTab);
        await replaceAccountUrl(nextTab);
      })();
    });
    if ($session.authenticated) loadEdits();
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
  <PortalFrame eyebrow="Archimap" title={$t('account.title')} description={$t('account.subtitle')}>
    <div class="portal-notice">
      <h2 class="text-xl font-extrabold ui-text-strong">{$t('account.authRequiredTitle')}</h2>
      <p class="mt-2 text-sm ui-text-muted">{$t('account.authRequiredText')}</p>
    </div>
  </PortalFrame>
{:else}
  <PortalFrame eyebrow="Archimap" title={$t('account.title')} description={$t('account.subtitle')}>
    <svelte:fragment slot="meta">
      <UiBadge variant="default"><strong>{$t('account.profile.email')}</strong>{email || '-'}</UiBadge>
      <UiBadge variant="accent"><strong>{$t('account.tabs.edits')}</strong>{edits.length}</UiBadge>
    </svelte:fragment>

    <svelte:fragment slot="lead">
      <div class="portal-lead-grid">
        <article class="portal-stat">
          <span>{$t('account.profile.title')}</span>
          <strong>{accountUserLabel}</strong>
        </article>
        <article class="portal-stat">
          <span>{$t('account.profile.email')}</span>
          <strong>{email || '-'}</strong>
        </article>
        <article class="portal-stat">
          <span>{$t('account.tabs.edits')}</span>
          <strong>{visibleEdits.length} / {edits.length}</strong>
        </article>
      </div>
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
            <form class="mt-4 space-y-4" on:submit={saveProfile}>
              <div>
                <UiLabel for="account-first-name" className="mb-1 block text-sm font-medium ui-text-body">{$t('account.profile.firstName')}</UiLabel>
                <UiInput id="account-first-name" bind:value={firstName} />
              </div>
              <div>
                <UiLabel for="account-last-name" className="mb-1 block text-sm font-medium ui-text-body">{$t('account.profile.lastName')}</UiLabel>
                <UiInput id="account-last-name" bind:value={lastName} />
              </div>
              <div>
                <UiLabel for="account-email" className="mb-1 block text-sm font-medium ui-text-body">{$t('account.profile.email')}</UiLabel>
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
            <form class="mt-4 space-y-4" on:submit={changePassword}>
              <UiInput
                type="password"
                placeholder={$t('account.security.currentPassword')}
                bind:value={currentPassword}
                required
              />
              <UiInput
                type="password"
                placeholder={$t('account.security.newPassword')}
                bind:value={newPassword}
                required
              />
              <UiInput
                type="password"
                placeholder={$t('account.security.repeatPassword')}
                bind:value={confirmNewPassword}
                required
              />
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
      <div class="mt-4 grid gap-4 overflow-hidden min-h-0" class:lg:grid-cols-[1.1fr_1fr]={accountPaneOpen} class:lg:grid-cols-1={!accountPaneOpen}>
        <section class="flex flex-col space-y-3 rounded-2xl border ui-border ui-surface-base p-3 min-h-0 overflow-hidden">
          <div class="ui-filter-toolbar ui-filter-toolbar--account-edits">
            <UiInput type="search" placeholder={$t('account.edits.searchPlaceholder')} bind:value={editsQuery} />
            <UiDateRangePicker
              value={editsDateRange}
              locale={$locale}
              placeholder={$t('account.edits.dateRangePlaceholder')}
              calendarLabel={$t('account.edits.dateRangeLabel')}
              clearLabel={$t('common.clear')}
              onchange={(event) => (editsDateRange = event.detail.value)}
            />
            <UiSelect items={editsFilterItems} bind:value={editsFilter} onchange={loadEdits} />
            <div class="ui-filter-toolbar__group ui-filter-toolbar__group--limit">
              <UiSelect items={editsLimitItems} bind:value={editsLimit} onchange={loadEdits} />
              <UiButton
                type="button"
                variant="secondary"
                className="w-full min-h-11 rounded-[1rem] px-4 py-3 text-sm sm:w-auto"
                onclick={loadEdits}
              >
                {$t('common.refresh')}
              </UiButton>
            </div>
          </div>
          <p class="text-sm ui-text-muted">{editsStatus}</p>
          <div class="h-[36vh] min-h-[260px] flex-shrink-0 overflow-hidden rounded-xl border ui-border" bind:this={mapEl}></div>
          <UiScrollArea className="flex-1 min-h-0 rounded-xl border ui-border">
            <UiTable containerClassName="ui-surface-base">
            <UiTableHeader>
              <UiTableRow className="hover:[&>th]:bg-transparent">
                <UiTableHead>{$t('account.edits.tableObject')}</UiTableHead>
                <UiTableHead>{$t('account.edits.tableAuthor')}</UiTableHead>
                <UiTableHead>{$t('account.edits.tableStatus')}</UiTableHead>
                <UiTableHead>{$t('account.edits.tableChanges')}</UiTableHead>
              </UiTableRow>
            </UiTableHeader>
            <UiTableBody>
              {#if editsLoading}
                <UiTableRow>
                  <UiTableCell colspan="4" className="ui-text-subtle">{$t('account.edits.loading')}</UiTableCell>
                </UiTableRow>
              {:else if visibleEdits.length===0}
                <UiTableRow>
                  <UiTableCell colspan="4" className="ui-text-subtle">{$t('account.edits.empty')}</UiTableCell>
                </UiTableRow>
              {:else}
                {#each visibleEdits as it (`${it.id || it.editId}`)}
                  {@const statusMeta = getStatusBadgeMeta(it.status, translateNow)}
                  {@const counters = getChangeCounters(it.changes)}
                  <UiTableRow
                    className="cursor-pointer hover:[&>td]:[background:color-mix(in_srgb,var(--accent-soft)_44%,var(--panel-solid))]"
                    onclick={() => openEdit(it.id || it.editId)}
                  >
                    <UiTableCell className="min-w-0">
                      <p class="font-semibold ui-text-strong break-words line-clamp-1">{getEditAddress(it)}</p>
                      <p class="text-xs ui-text-subtle truncate">{$t('account.edits.id')}: {it.osmType}/{it.osmId}</p>
                      <div class="mt-1 flex flex-wrap gap-1">
                        {#if it.orphaned}
                          <span class="rounded-md ui-surface-danger px-2 py-1 text-[11px] font-semibold ui-text-danger">{$t('account.edits.orphaned')}</span>
                        {/if}
                        {#if !it.osmPresent && !it.orphaned}
                          <span class="rounded-md ui-surface-warning px-2 py-1 text-[11px] font-semibold ui-text-warning">{$t('account.edits.missingTarget')}</span>
                        {/if}
                      {#if it.sourceOsmChanged}
                          <span class="rounded-md ui-surface-info px-2 py-1 text-[11px] font-semibold ui-text-info">{$t('account.edits.osmChanged')}</span>
                        {/if}
                        {#if it.syncStatus && it.syncStatus !== 'unsynced'}
                          {@const syncMeta = getSyncBadgeMeta(it.syncStatus)}
                          <span class={`rounded-md px-2 py-1 text-[11px] font-semibold ${syncMeta.cls}`}>{syncMeta.text}</span>
                        {/if}
                      </div>
                      {#if String(it?.adminComment || '').trim()}
                        <p class="mt-1 text-xs ui-text-danger">{$t('account.edits.comment')}: {String(it.adminComment).trim()}</p>
                      {/if}
                      {#if it.syncChangesetId}
                        <p class="mt-1 text-xs ui-text-subtle">{$t('account.edits.syncChangeset')}: #{it.syncChangesetId}</p>
                      {/if}
                    </UiTableCell>
                    <UiTableCell>{it.updatedBy || '-'}</UiTableCell>
                    <UiTableCell>
                      <span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {statusMeta.cls}">{statusMeta.text}</span>
                    </UiTableCell>
                    <UiTableCell>
                      <div class="flex flex-wrap items-center gap-2">
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
        </section>
        {#if detailPaneVisible}
        <section class="flex flex-col space-y-3 rounded-2xl border ui-border ui-surface-base p-3 min-h-0 overflow-hidden" in:fade={{ duration: 180 }} out:fade={{ duration: 180 }} on:outroend={onDetailPaneOutroEnd}>
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-base font-bold ui-text-strong">{$t('account.edits.detailTitle')}</h3>
            <UiButton type="button" variant="secondary" size="close" aria-label={$t('account.edits.closeDetail')} onclick={closeEditPanel}><CloseIcon class="ui-close-icon" /></UiButton>
          </div>
          {#if detailLoading}
            <p class="text-sm ui-text-subtle">{$t('account.edits.loading')}</p>
          {:else if !selectedEdit}
            <p class="text-sm ui-text-subtle">{$t('account.edits.selectHint')}</p>
          {:else}
                {@const selectedStatusMeta = getStatusBadgeMeta(selectedEdit.status, translateNow)}
            <p class="flex flex-wrap items-center gap-2 text-sm ui-text-muted"><span>ID: {selectedEdit.editId || selectedEdit.id} | {selectedEdit.osmType}/{selectedEdit.osmId}</span><span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {selectedStatusMeta.cls}">{selectedStatusMeta.text}</span></p>
            {#if selectedEdit.syncStatus && selectedEdit.syncStatus !== 'unsynced'}
              <div class="rounded-xl border ui-border ui-surface-muted p-3 text-sm ui-text-body">
                <p><strong>{$t('account.edits.syncStatus')}:</strong> {getSyncBadgeMeta(selectedEdit.syncStatus).text}</p>
                <p><strong>{$t('account.edits.syncAttemptedAt')}:</strong> {formatUiDate(selectedEdit.syncAttemptedAt) || '---'}</p>
                <p><strong>{$t('account.edits.syncSucceededAt')}:</strong> {formatUiDate(selectedEdit.syncSucceededAt) || '---'}</p>
                <p><strong>{$t('account.edits.syncCleanedAt')}:</strong> {formatUiDate(selectedEdit.syncCleanedAt) || '---'}</p>
                <p><strong>{$t('account.edits.syncChangeset')}:</strong> {selectedEdit.syncChangesetId || '---'}</p>
                {#if selectedEdit.syncSummary}
                  <p class="mt-1 text-xs ui-text-subtle break-words">{JSON.stringify(selectedEdit.syncSummary)}</p>
                {/if}
                {#if selectedEdit.syncError}
                  <p class="mt-1 text-xs ui-text-danger break-words">{selectedEdit.syncError}</p>
                {/if}
              </div>
            {/if}
            {#if selectedEdit.orphaned || !selectedEdit.osmPresent || selectedEdit.sourceOsmChanged}
              <div class="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                {#if selectedEdit.orphaned}
                  <p>{$t('account.edits.orphanedHelp')}</p>
                {/if}
                {#if !selectedEdit.osmPresent && !selectedEdit.orphaned}
                  <p>{$t('account.edits.missingTargetHelp')}</p>
                {/if}
                {#if selectedEdit.sourceOsmChanged}
                  <p>{$t('account.edits.osmChangedHelp')}</p>
                {/if}
              </div>
            {/if}
            <UiScrollArea
              className="max-h-[42vh] rounded-xl border ui-border"
              contentClassName="space-y-2 p-2"
            >
              {#if !Array.isArray(selectedEdit.changes) || selectedEdit.changes.length === 0}
                <p class="text-sm ui-text-subtle">{$t('account.edits.noChanges')}</p>
              {:else}
                {#each selectedEdit.changes as ch (`${ch.field}`)}
                  <div class="rounded-lg border ui-border ui-surface-muted p-2"><p class="text-sm font-semibold ui-text-strong">{ch.label || ch.field}</p><p class="text-xs ui-text-muted"><span class="line-through">{String(ch.osmValue ?? $t('account.edits.emptyValue'))}</span> -> <strong>{String(ch.localValue ?? $t('account.edits.emptyValue'))}</strong></p></div>
                {/each}
              {/if}
            </UiScrollArea>
            {#if detailStatus}<p class="text-sm ui-text-muted">{detailStatus}</p>{/if}
          {/if}
        </section>
        {/if}
      </div>
    {/if}
  </PortalFrame>
{/if}

