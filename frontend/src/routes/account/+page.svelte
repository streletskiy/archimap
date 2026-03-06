<script>
  import { onMount, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import PortalFrame from '$lib/components/shell/PortalFrame.svelte';
  import { session, setSession } from '$lib/stores/auth';
  import { apiJson } from '$lib/services/http';
  import { getRuntimeConfig } from '$lib/services/config';
  import { loadMapRuntime, resolvePmtilesUrl } from '$lib/services/map-runtime';
  import { t, translateNow } from '$lib/i18n/index';
  import { getChangeCounters, getEditAddress, getEditKey, getStatusBadgeMeta, parseEditKey } from '$lib/utils/edit-ui';
  import { focusMapOnGeometry, getGeometryCenter } from '$lib/utils/map-geometry';

  const LIGHT = '/styles/positron-custom.json';
  const DARK = '/styles/dark-matter-custom.json';
  const SRC = 'account-edited-points';
  const L_CLUSTER = 'account-edited-points-clusters';
  const L_COUNT = 'account-edited-points-cluster-count';
  const L_POINT = 'account-edited-points-unclustered';

  let activeTab = 'settings';
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
  let editsDate = '';

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
    const pmtilesUrl = resolvePmtilesUrl(cfg.buildingsPmtiles.url, window.location.origin);
    map = new maplibregl.Map({
      container: mapEl,
      style: styleByTheme(),
      center: [cfg.mapDefault.lon, cfg.mapDefault.lat],
      zoom: Math.max(12, Number(cfg.mapDefault.zoom || 14))
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.on('style.load', () => {
      if (!map.getSource('local-buildings')) map.addSource('local-buildings', { type: 'vector', url: `pmtiles://${pmtilesUrl}` });
      if (!map.getSource('selected-building')) map.addSource('selected-building', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, cluster: true, clusterRadius: 44, clusterMaxZoom: 12 });
      if (!map.getLayer('edited-fill')) map.addLayer({ id: 'edited-fill', type: 'fill', source: 'local-buildings', 'source-layer': cfg.buildingsPmtiles.sourceLayer, minzoom: 13, paint: { 'fill-color': '#5B62F0', 'fill-opacity': 0.25 } });
      if (!map.getLayer('edited-line')) map.addLayer({ id: 'edited-line', type: 'line', source: 'local-buildings', 'source-layer': cfg.buildingsPmtiles.sourceLayer, minzoom: 13, paint: { 'line-color': '#5B62F0', 'line-width': 2 } });
      if (!map.getLayer('selected-fill')) map.addLayer({ id: 'selected-fill', type: 'fill', source: 'selected-building', paint: { 'fill-color': '#5B62F0', 'fill-opacity': 0.2 } });
      if (!map.getLayer('selected-line')) map.addLayer({ id: 'selected-line', type: 'line', source: 'selected-building', paint: { 'line-color': '#5B62F0', 'line-width': 3 } });
      if (!map.getLayer(L_CLUSTER)) map.addLayer({ id: L_CLUSTER, type: 'circle', source: SRC, filter: ['has', 'point_count'], paint: { 'circle-color': '#5B62F0', 'circle-radius': ['step', ['get', 'point_count'], 14, 20, 18, 80, 23], 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
      if (!map.getLayer(L_COUNT)) map.addLayer({ id: L_COUNT, type: 'symbol', source: SRC, filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Open Sans Bold'] }, paint: { 'text-color': '#fff' } });
      if (!map.getLayer(L_POINT)) map.addLayer({ id: L_POINT, type: 'circle', source: SRC, filter: ['!', ['has', 'point_count']], paint: { 'circle-color': '#5B62F0', 'circle-radius': 7, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
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
    map.on('click', 'edited-fill', async (e) => {
      const v = Number(e?.features?.[0]?.id);
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
    if (map.getLayer('edited-fill')) map.setFilter('edited-fill', ['in', ['id'], ['literal', ids]]);
    if (map.getLayer('edited-line')) map.setFilter('edited-line', ['in', ['id'], ['literal', ids]]);
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

  async function switchTab(tab) {
    activeTab = tab;
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

  $: {
    const q = String(editsQuery || '').trim().toLowerCase();
    const date = String(editsDate || '').trim();
    visibleEdits = edits.filter((item) => {
      const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`.toLowerCase();
      const address = getEditAddress(item).toLowerCase();
      const updatedAt = String(item?.updatedAt || '');
      if (q && !address.includes(q) && !osmKey.includes(q)) return false;
      if (date && !updatedAt.startsWith(date)) return false;
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

  onMount(() => {
    if ($session.authenticated) loadEdits();
    const obs = new MutationObserver(() => { if (map) map.setStyle(styleByTheme()); });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      obs.disconnect();
      destroyMap();
    };
  });
</script>

{#if !$session.authenticated}
  <PortalFrame eyebrow="Archimap" title={$t('account.title')} description={$t('account.subtitle')}>
    <div class="portal-notice">
      <h2 class="text-xl font-extrabold text-slate-900">{$t('account.authRequiredTitle')}</h2>
      <p class="mt-2 text-sm text-slate-600">{$t('account.authRequiredText')}</p>
    </div>
  </PortalFrame>
{:else}
  <PortalFrame eyebrow="Archimap" title={$t('account.title')} description={$t('account.subtitle')}>
    <svelte:fragment slot="meta">
      <span class="ui-chip"><strong>{$t('account.profile.email')}</strong>{email || '-'}</span>
      <span class="ui-chip"><strong>{$t('account.tabs.edits')}</strong>{edits.length}</span>
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

    <ul class="ui-tab-shell flex flex-wrap gap-1" role="tablist"><li><button type="button" class="ui-tab-btn" class:ui-tab-btn-active={activeTab === 'settings'} on:click={() => switchTab('settings')}>{$t('account.tabs.settings')}</button></li><li><button type="button" class="ui-tab-btn" class:ui-tab-btn-active={activeTab === 'edits'} on:click={() => switchTab('edits')}>{$t('account.tabs.edits')}</button></li></ul>
    {#if activeTab === 'settings'}
      <div class="mt-4 grid gap-4 xl:grid-cols-3">
          <section class="rounded-2xl border border-slate-200 bg-slate-50 p-4"><h3 class="text-base font-bold text-slate-900">{$t('account.profile.title')}</h3><form class="mt-4 space-y-4" on:submit={saveProfile}><div><label for="account-first-name" class="mb-1 block text-sm font-medium text-slate-700">{$t('account.profile.firstName')}</label><input id="account-first-name" class="ui-field bg-white" bind:value={firstName} /></div><div><label for="account-last-name" class="mb-1 block text-sm font-medium text-slate-700">{$t('account.profile.lastName')}</label><input id="account-last-name" class="ui-field bg-white" bind:value={lastName} /></div><div><label for="account-email" class="mb-1 block text-sm font-medium text-slate-700">{$t('account.profile.email')}</label><input id="account-email" class="ui-field bg-white text-slate-500" readonly value={email} /></div><button type="submit" class="ui-btn ui-btn-primary">{$t('account.profile.save')}</button></form>{#if profileStatus}<p class="mt-3 text-sm text-slate-600">{profileStatus}</p>{/if}</section>
          <section class="rounded-2xl border border-slate-200 bg-slate-50 p-4"><h3 class="text-base font-bold text-slate-900">{$t('account.security.title')}</h3><form class="mt-4 space-y-4" on:submit={changePassword}><input type="password" class="ui-field bg-white" placeholder={$t('account.security.currentPassword')} bind:value={currentPassword} required /><input type="password" class="ui-field bg-white" placeholder={$t('account.security.newPassword')} bind:value={newPassword} required /><input type="password" class="ui-field bg-white" placeholder={$t('account.security.repeatPassword')} bind:value={confirmNewPassword} required /><button type="submit" class="ui-btn ui-btn-outline-brand">{$t('account.security.change')}</button></form>{#if passwordStatus}<p class="mt-3 text-sm text-slate-600">{passwordStatus}</p>{/if}</section>
          <section class="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h3 class="text-base font-bold text-slate-900">{$t('account.notifications.title')}</h3>
            <div class="mt-4 space-y-4">
              <div class="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
                <div>
                  <p class="text-sm font-semibold text-slate-900">{$t('account.notifications.commentsTitle')}</p>
                  <p class="mt-1 text-sm text-slate-500">{$t('account.notifications.commentsText')}</p>
                </div>
                <label class="relative inline-flex cursor-not-allowed items-center opacity-60">
                  <input type="checkbox" class="peer sr-only" disabled aria-disabled="true" />
                  <div class="h-6 w-11 rounded-full bg-slate-300 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-slate-300 after:bg-white after:transition-all peer-checked:bg-brand-purple peer-checked:after:translate-x-full peer-checked:after:border-white"></div>
                </label>
              </div>
              <div class="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
                <div>
                  <p class="text-sm font-semibold text-slate-900">{$t('account.notifications.moderationTitle')}</p>
                  <p class="mt-1 text-sm text-slate-500">{$t('account.notifications.moderationText')}</p>
                </div>
                <label class="relative inline-flex cursor-not-allowed items-center opacity-60">
                  <input type="checkbox" class="peer sr-only" disabled aria-disabled="true" />
                  <div class="h-6 w-11 rounded-full bg-slate-300 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-slate-300 after:bg-white after:transition-all peer-checked:bg-brand-purple peer-checked:after:translate-x-full peer-checked:after:border-white"></div>
                </label>
              </div>
              <div class="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
                <div>
                  <p class="text-sm font-semibold text-slate-900">{$t('account.notifications.weeklyTitle')}</p>
                  <p class="mt-1 text-sm text-slate-500">{$t('account.notifications.weeklyText')}</p>
                </div>
                <label class="relative inline-flex cursor-not-allowed items-center opacity-60">
                  <input type="checkbox" class="peer sr-only" disabled aria-disabled="true" />
                  <div class="h-6 w-11 rounded-full bg-slate-300 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-slate-300 after:bg-white after:transition-all peer-checked:bg-brand-purple peer-checked:after:translate-x-full peer-checked:after:border-white"></div>
                </label>
              </div>
            </div>
          </section>
          <section class="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h3 class="text-base font-bold text-slate-900">{$t('account.legal.title')}</h3>
            <p class="mt-1 text-sm text-slate-600">{$t('account.legal.text')}</p>
            <div class="mt-4 space-y-2">
              <a href="/info?tab=legal&doc=terms" class="block rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-indigo-700 underline underline-offset-2 hover:bg-slate-50">{$t('account.legal.terms')}</a>
              <a href="/info?tab=legal&doc=privacy" class="block rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-indigo-700 underline underline-offset-2 hover:bg-slate-50">{$t('account.legal.privacy')}</a>
            </div>
          </section>
      </div>
    {:else}
      <div class="mt-4 grid gap-4 overflow-x-hidden" class:lg:grid-cols-[1.1fr_1fr]={accountPaneOpen} class:lg:grid-cols-1={!accountPaneOpen}>
        <section class="space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
          <div class="grid gap-2 lg:grid-cols-[1.6fr_repeat(2,minmax(0,1fr))]"><input class="ui-field" type="search" placeholder={$t('account.edits.searchPlaceholder')} bind:value={editsQuery} /><input class="ui-field" type="date" bind:value={editsDate} /><div class="flex gap-2"><select class="ui-field ui-field-xs" bind:value={editsFilter} on:change={loadEdits}><option value="all">{$t('account.edits.filterAll')}</option><option value="pending">{$t('account.edits.filterPending')}</option><option value="accepted">{$t('account.edits.filterAccepted')}</option><option value="partially_accepted">{$t('account.edits.filterPartiallyAccepted')}</option><option value="rejected">{$t('account.edits.filterRejected')}</option><option value="superseded">{$t('account.edits.filterSuperseded')}</option></select><select class="ui-field ui-field-xs" bind:value={editsLimit} on:change={loadEdits}><option value={100}>100</option><option value={200}>200</option><option value={500}>500</option></select><button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" on:click={loadEdits}>{$t('common.refresh')}</button></div></div>
          <p class="text-sm text-slate-600">{editsStatus}</p>
          <div class="h-[36vh] min-h-[260px] overflow-hidden rounded-xl border border-slate-200" bind:this={mapEl}></div>
          <div class="overflow-x-auto rounded-xl border border-slate-200">
            <table class="min-w-full text-sm">
              <thead>
                <tr class="border-b border-slate-200 text-left text-slate-600">
                  <th class="px-3 py-2">{$t('account.edits.tableObject')}</th>
                  <th class="px-3 py-2">{$t('account.edits.tableAuthor')}</th>
                  <th class="px-3 py-2">{$t('account.edits.tableStatus')}</th>
                  <th class="px-3 py-2">{$t('account.edits.tableChanges')}</th>
                </tr>
              </thead>
              <tbody>
                {#if editsLoading}
                  <tr><td colspan="4" class="px-3 py-3 text-slate-500">{$t('account.edits.loading')}</td></tr>
                {:else if visibleEdits.length===0}
                  <tr><td colspan="4" class="px-3 py-3 text-slate-500">{$t('account.edits.empty')}</td></tr>
                {:else}
                  {#each visibleEdits as it (`${it.id || it.editId}`)}
                        {@const statusMeta = getStatusBadgeMeta(it.status, translateNow)}
                    {@const counters = getChangeCounters(it.changes)}
                    <tr class="cursor-pointer border-b border-slate-100 hover:bg-slate-50" on:click={() => openEdit(it.id || it.editId)}>
                      <td class="px-3 py-2"><p class="font-semibold text-slate-900">{getEditAddress(it)}</p><p class="text-xs text-slate-500">{$t('account.edits.id')}: {it.osmType}/{it.osmId}</p>{#if String(it?.adminComment || '').trim()}<p class="mt-1 text-xs text-rose-600">{$t('account.edits.comment')}: {String(it.adminComment).trim()}</p>{/if}</td>
                      <td class="px-3 py-2">{it.updatedBy || '-'}</td>
                      <td class="px-3 py-2"><span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {statusMeta.cls}">{statusMeta.text}</span></td>
                      <td class="px-3 py-2"><div class="flex flex-wrap items-center gap-2"><span class="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{counters.total} {$t('account.edits.total')}</span>{#if counters.created > 0}<span class="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-600">+{counters.created} {$t('account.edits.created')}</span>{/if}{#if counters.modified > 0}<span class="rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-600">~{counters.modified} {$t('account.edits.modified')}</span>{/if}</div></td>
                    </tr>
                  {/each}
                {/if}
              </tbody>
            </table>
          </div>
        </section>
        {#if detailPaneVisible}
        <section class="space-y-3 rounded-2xl border border-slate-200 bg-white p-3" in:fade={{ duration: 180 }} out:fade={{ duration: 180 }} on:outroend={onDetailPaneOutroEnd}>
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-base font-bold text-slate-900">{$t('account.edits.detailTitle')}</h3>
            <button type="button" class="ui-btn ui-btn-secondary ui-btn-xs ui-btn-close" aria-label={$t('account.edits.closeDetail')} on:click={closeEditPanel}><svg class="ui-close-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6L18 18" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" /><path d="M18 6L6 18" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" /></svg></button>
          </div>
          {#if detailLoading}
            <p class="text-sm text-slate-500">{$t('account.edits.loading')}</p>
          {:else if !selectedEdit}
            <p class="text-sm text-slate-500">{$t('account.edits.selectHint')}</p>
          {:else}
                {@const selectedStatusMeta = getStatusBadgeMeta(selectedEdit.status, translateNow)}
            <p class="flex flex-wrap items-center gap-2 text-sm text-slate-600"><span>ID: {selectedEdit.editId || selectedEdit.id} | {selectedEdit.osmType}/{selectedEdit.osmId}</span><span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {selectedStatusMeta.cls}">{selectedStatusMeta.text}</span></p>
            <div class="max-h-[42vh] space-y-2 overflow-auto rounded-xl border border-slate-200 p-2">
              {#if !Array.isArray(selectedEdit.changes) || selectedEdit.changes.length === 0}
                <p class="text-sm text-slate-500">{$t('account.edits.noChanges')}</p>
              {:else}
                {#each selectedEdit.changes as ch (`${ch.field}`)}
                  <div class="rounded-lg border border-slate-200 bg-slate-50 p-2"><p class="text-sm font-semibold text-slate-900">{ch.label || ch.field}</p><p class="text-xs text-slate-600"><span class="line-through">{String(ch.osmValue ?? $t('account.edits.emptyValue'))}</span> -> <strong>{String(ch.localValue ?? $t('account.edits.emptyValue'))}</strong></p></div>
                {/each}
              {/if}
            </div>
            {#if detailStatus}<p class="text-sm text-slate-600">{detailStatus}</p>{/if}
          {/if}
        </section>
        {/if}
      </div>
    {/if}
  </PortalFrame>
{/if}

