<script>
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { fade } from 'svelte/transition';
  import PortalFrame from '$lib/components/shell/PortalFrame.svelte';
  import { parseUrlState, patchUrlState } from '$lib/client/urlState';
  import { session } from '$lib/stores/auth';
  import { apiJson } from '$lib/services/http';
  import { getRuntimeConfig } from '$lib/services/config';
  import { loadMapRuntime, resolvePmtilesUrl } from '$lib/services/map-runtime';
  import { t, translateNow } from '$lib/i18n/index';
  import { formatUiDate, getChangeCounters, getEditAddress, getEditKey, getStatusBadgeMeta, parseEditKey } from '$lib/utils/edit-ui';
  import { focusMapOnGeometry, getGeometryCenter } from '$lib/utils/map-geometry';

  const LIGHT = '/styles/positron-custom.json';
  const DARK = '/styles/dark-matter-custom.json';
  const SRC = 'edited-points';
  const L_CLUSTER = 'edited-points-clusters';
  const L_COUNT = 'edited-points-cluster-count';
  const L_POINT = 'edited-points-unclustered';

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
  let pendingUrlEditId = null;
  let adminUrlSyncBusy = false;
  let lastAppliedUrlEditId = null;

  let general = { appDisplayName: 'archimap', appBaseUrl: '', registrationEnabled: true, userEditRequiresPermission: true };
  let generalLoading = false;
  let generalStatus = '';
  let smtp = { url: '', host: '', port: 587, secure: false, user: '', pass: '', from: '', hasPassword: false };
  let smtpLoading = false;
  let smtpStatus = '';
  let smtpTestEmail = '';

  let mapEl;
  let map = null;
  let maplibregl = null;
  let mapRuntimePromise = null;
  let protocol = null;
  let mapInitNonce = 0;
  const centerByKey = new Map();
  const editIdByKey = new Map();

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
      usersStatus = users.length ? translateNow('admin.users.found', { count: users.length }) : translateNow('admin.empty');
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
        body: JSON.stringify({ email: String(user?.email || '').trim().toLowerCase(), canEdit: !Boolean(user?.canEdit) })
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
        body: JSON.stringify({ email: String(user?.email || '').trim().toLowerCase(), isAdmin: !Boolean(user?.isAdmin) })
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
      editsUsers = [...new Set(edits.map((item) => String(item?.updatedBy || '').trim().toLowerCase()).filter(Boolean))].sort();
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
      detailStatus = '';
      try {
        const feature = await apiJson(`/api/building/${encodeURIComponent(selectedEdit.osmType)}/${encodeURIComponent(selectedEdit.osmId)}`);
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
          if (d === 'reject') rejected.push(f); else accepted.push(f);
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
            body: JSON.stringify({ fields: accepted, values, comment: commentWithRejected(moderationComment, rejected) })
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
      smtp = { url: String(s.url || ''), host: String(s.host || ''), port: Number(s.port || 587), secure: Boolean(s.secure), user: String(s.user || ''), pass: '', from: String(s.from || ''), hasPassword: Boolean(s.hasPassword) };
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
        body: JSON.stringify({ testEmail: smtpTestEmail, smtp: { ...smtp, keepPassword: String(smtp.pass || '').trim() === '' } })
      });
      smtpStatus = String(data?.message || translateNow('admin.settings.smtpTestSent'));
    } catch (e) {
      smtpStatus = msg(e, translateNow('admin.settings.smtpTestFailed'));
    } finally {
      smtpLoading = false;
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
      await loadEdits();
    }
    if (tab === 'users') loadUsers();
    if (tab === 'settings') {
      await resetEditPanelState();
      destroyMap();
      loadGeneral();
      if ($session.user?.isMasterAdmin) loadSmtp();
    }
    if (tab === 'users') {
      await resetEditPanelState();
      destroyMap();
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
    const q = String(editsQuery || '').trim().toLowerCase();
    const date = String(editsDate || '').trim();
    const user = String(editsUser || '').trim().toLowerCase();
    const status = String(editsFilter || 'all').trim().toLowerCase();
    visibleEdits = edits.filter((item) => {
      const osmKey = `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`.toLowerCase();
      const address = getEditAddress(item).toLowerCase();
      const author = String(item?.updatedBy || '').trim().toLowerCase();
      const updatedAt = String(item?.updatedAt || '');
      if (q && !address.includes(q) && !osmKey.includes(q)) return false;
      if (date && !updatedAt.startsWith(date)) return false;
      if (user && author !== user) return false;
      if (status !== 'all' && String(item?.status || '').trim().toLowerCase() !== status) return false;
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
          <span>{$t('admin.tabs.settings')}</span>
          <strong>{activeTab === 'edits' ? $t('admin.tabs.edits') : activeTab === 'users' ? $t('admin.tabs.users') : $t('admin.tabs.settings')}</strong>
        </article>
      </div>
    </svelte:fragment>

    <ul class="ui-tab-shell flex flex-wrap gap-1" role="tablist">
      <li><button type="button" class="ui-tab-btn" class:ui-tab-btn-active={activeTab === 'edits'} on:click={() => switchTab('edits')}>{$t('admin.tabs.edits')}</button></li>
      <li><button type="button" class="ui-tab-btn" class:ui-tab-btn-active={activeTab === 'users'} on:click={() => switchTab('users')}>{$t('admin.tabs.users')}</button></li>
      <li><button type="button" class="ui-tab-btn" class:ui-tab-btn-active={activeTab === 'settings'} on:click={() => switchTab('settings')}>{$t('admin.tabs.settings')}</button></li>
    </ul>

    {#if activeTab === 'users'}
      <div class="mt-3 space-y-3">
          <form class="grid gap-2 lg:grid-cols-[1.4fr_repeat(4,minmax(0,1fr))]" on:submit|preventDefault={loadUsers}>
            <input class="ui-field" type="search" placeholder={$t('admin.users.search')} bind:value={usersQuery} />
            <select class="ui-field" bind:value={usersRole}><option value="all">{$t('admin.users.roleAll')}</option><option value="admin">{$t('admin.users.roleAdmins')}</option><option value="user">{$t('admin.users.roleUsers')}</option></select>
            <select class="ui-field" bind:value={usersCanEdit}><option value="all">{$t('admin.users.permAll')}</option><option value="yes">{$t('admin.users.permYes')}</option><option value="no">{$t('admin.users.permNo')}</option></select>
            <select class="ui-field" bind:value={usersHasEdits}><option value="all">{$t('admin.users.editsAll')}</option><option value="yes">{$t('admin.users.editsYes')}</option><option value="no">{$t('admin.users.editsNo')}</option></select>
            <div class="flex gap-2"><select class="ui-field" bind:value={usersSortBy}><option value="createdAt">{$t('admin.users.sortRegistered')}</option><option value="email">{$t('admin.users.sortEmail')}</option><option value="editsCount">{$t('admin.users.sortEditsCount')}</option><option value="lastEditAt">{$t('admin.users.sortLastEdit')}</option><option value="firstName">{$t('admin.users.sortFirstName')}</option><option value="lastName">{$t('admin.users.sortLastName')}</option></select><select class="ui-field ui-field-xs" bind:value={usersSortDir}><option value="desc">{$t('common.desc')}</option><option value="asc">{$t('common.asc')}</option></select><button type="submit" class="ui-btn ui-btn-secondary">{$t('common.refresh')}</button></div>
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
                {:else if users.length===0}
                  <tr><td colspan="6" class="px-3 py-3 text-slate-500">{$t('admin.empty')}</td></tr>
                {:else}
                  {#each users as u (`${u.email}`)}
                    <tr class="border-b border-slate-100">
                      <td class="px-3 py-2">
                        <p class="font-semibold text-slate-900">{u.email}</p>
                        {#if (u.firstName || u.lastName)}
                          <p class="text-xs text-slate-500">{String(u.firstName || '').trim()} {String(u.lastName || '').trim()}</p>
                        {/if}
                      </td>
                      <td class="px-3 py-2">
                        {#if u.isMasterAdmin}
                          <span class="badge-pill mr-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">{$t('admin.users.masterAdmin')}</span>
                        {/if}
                        <span class="badge-pill mr-1 rounded-full px-2.5 py-1 text-xs font-semibold {u.isAdmin ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-700'}">{u.isAdmin ? $t('admin.users.admin') : $t('admin.users.user')}</span>
                        <span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {u.canEdit ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-700'}">{u.canEdit ? $t('admin.users.canEdit') : $t('admin.users.readOnly')}</span>
                      </td>
                      <td class="px-3 py-2">{u.editsCount || 0}</td>
                      <td class="px-3 py-2">{formatUiDate(u.createdAt)}</td>
                      <td class="px-3 py-2">{formatUiDate(u.lastEditAt)}</td>
                      <td class="px-3 py-2">
                        <button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" on:click={() => toggleCanEdit(u)}>{u.canEdit ? $t('admin.users.disableEdit') : $t('admin.users.enableEdit')}</button>
                        <button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" on:click={() => toggleAdmin(u)} disabled={!$session.user?.isMasterAdmin || Boolean(u.isMasterAdmin)}>{u.isAdmin ? $t('admin.users.demoteAdmin') : $t('admin.users.promoteAdmin')}</button>
                      </td>
                    </tr>
                  {/each}
                {/if}
              </tbody>
            </table>
          </div>
      </div>
    {:else if activeTab === 'settings'}
      {#if !$session.user?.isMasterAdmin}
        <p class="mt-3 text-sm text-slate-600">{$t('admin.settings.masterOnly')}</p>
      {:else}
        <div class="mt-3 grid gap-4 lg:grid-cols-2">
          <form class="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-4" on:submit={saveGeneral}><h3 class="text-base font-bold text-slate-900">{$t('admin.settings.generalTitle')}</h3><input class="ui-field" bind:value={general.appDisplayName} placeholder={$t('admin.settings.appNamePlaceholder')} /><input class="ui-field" bind:value={general.appBaseUrl} placeholder={$t('admin.settings.baseUrlPlaceholder')} /><label class="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" bind:checked={general.registrationEnabled} /> {$t('admin.settings.registrationEnabled')}</label><label class="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" bind:checked={general.userEditRequiresPermission} /> {$t('admin.settings.editRequiresPermission')}</label><button type="submit" class="ui-btn ui-btn-primary" disabled={generalLoading}>{$t('common.save')}</button>{#if generalStatus}<p class="text-sm text-slate-600">{generalStatus}</p>{/if}</form>
          <form class="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-4" on:submit={saveSmtp}><h3 class="text-base font-bold text-slate-900">{$t('admin.settings.smtpTitle')}</h3><input class="ui-field" bind:value={smtp.url} placeholder={$t('admin.settings.smtpUrl')} /><div class="grid gap-2 sm:grid-cols-2"><input class="ui-field" bind:value={smtp.host} placeholder={$t('admin.settings.host')} /><input class="ui-field" type="number" min="1" max="65535" bind:value={smtp.port} placeholder={$t('admin.settings.port')} /></div><input class="ui-field" bind:value={smtp.user} placeholder={$t('admin.settings.user')} /><input class="ui-field" type="password" bind:value={smtp.pass} placeholder={smtp.hasPassword ? $t('admin.settings.passwordKeep') : $t('admin.settings.password')} /><input class="ui-field" bind:value={smtp.from} placeholder={$t('admin.settings.from')} /><label class="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" bind:checked={smtp.secure} /> {$t('admin.settings.secure')}</label><div class="grid gap-2 sm:grid-cols-[1fr_auto_auto]"><input class="ui-field" type="email" bind:value={smtpTestEmail} placeholder={$t('admin.settings.testEmail')} /><button type="button" class="ui-btn ui-btn-secondary" on:click={testSmtp} disabled={smtpLoading}>{$t('admin.settings.smtpTest')}</button><button type="submit" class="ui-btn ui-btn-primary" disabled={smtpLoading}>{$t('admin.settings.smtpSave')}</button></div>{#if smtpStatus}<p class="text-sm text-slate-600">{smtpStatus}</p>{/if}</form>
        </div>
      {/if}
    {:else}
      <div class="mt-3 grid gap-4 overflow-x-hidden" class:lg:grid-cols-[1.1fr_1fr]={adminPaneOpen} class:lg:grid-cols-1={!adminPaneOpen}>
        <section class="space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
          <div class="grid gap-2 lg:grid-cols-[1.4fr_repeat(4,minmax(0,1fr))]"><input class="ui-field" type="search" placeholder={$t('admin.edits.search')} bind:value={editsQuery} /><input class="ui-field" type="date" bind:value={editsDate} /><select class="ui-field" bind:value={editsUser}><option value="">{$t('admin.edits.userAll')}</option>{#each editsUsers as user (user)}<option value={user}>{user}</option>{/each}</select><select class="ui-field ui-field-xs" bind:value={editsFilter}><option value="all">{$t('admin.edits.statusAll')}</option><option value="pending">{$t('admin.edits.statusPending')}</option><option value="accepted">{$t('admin.edits.statusAccepted')}</option><option value="partially_accepted">{$t('admin.edits.statusPartiallyAccepted')}</option><option value="rejected">{$t('admin.edits.statusRejected')}</option><option value="superseded">{$t('admin.edits.statusSuperseded')}</option></select><div class="flex gap-2"><select class="ui-field ui-field-xs" bind:value={editsLimit} on:change={loadEdits}><option value={100}>100</option><option value={200}>200</option><option value={500}>500</option></select><button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" on:click={loadEdits}>{$t('common.refresh')}</button></div></div>
          <p class="text-sm text-slate-600">{editsStatus}</p>
          <div class="h-[36vh] min-h-[260px] overflow-hidden rounded-xl border border-slate-200" bind:this={mapEl}></div>
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
                {:else if visibleEdits.length===0}
                  <tr><td colspan="4" class="px-3 py-3 text-slate-500">{$t('admin.empty')}</td></tr>
                {:else}
                  {#each visibleEdits as it (`${it.id || it.editId}`)}
                    {@const statusMeta = getStatusBadgeMeta(it.status, translateNow)}
                    {@const counters = getChangeCounters(it.changes)}
                    <tr class="cursor-pointer border-b border-slate-100 hover:bg-slate-50" on:click={() => openEdit(it.id || it.editId)}>
                      <td class="px-3 py-2"><p class="font-semibold text-slate-900">{getEditAddress(it)}</p><p class="text-xs text-slate-500">ID: {it.osmType}/{it.osmId}</p></td>
                      <td class="px-3 py-2">{it.updatedBy || '-'}</td>
                      <td class="px-3 py-2"><span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {statusMeta.cls}">{statusMeta.text}</span></td>
                      <td class="px-3 py-2"><div class="flex flex-wrap items-center gap-2"><span class="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{counters.total} {$t('admin.edits.changesTotal')}</span>{#if counters.created > 0}<span class="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-600">+{counters.created} {$t('admin.edits.changesCreated')}</span>{/if}{#if counters.modified > 0}<span class="rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-600">~{counters.modified} {$t('admin.edits.changesModified')}</span>{/if}</div></td>
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
            <h3 class="text-base font-bold text-slate-900">{$t('admin.edits.detailTitle')}</h3>
            <button type="button" class="ui-btn ui-btn-secondary ui-btn-xs ui-btn-close" aria-label={$t('admin.edits.closeDetail')} on:click={closeEditPanel}><svg class="ui-close-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6L18 18" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" /><path d="M18 6L6 18" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" /></svg></button>
          </div>
          {#if detailLoading}
            <p class="text-sm text-slate-500">{$t('admin.loading')}</p>
          {:else if !selectedEdit}
            <p class="text-sm text-slate-500">{$t('admin.edits.selectHint')}</p>
          {:else}
            {@const selectedStatusMeta = getStatusBadgeMeta(selectedEdit.status, translateNow)}
            <p class="flex flex-wrap items-center gap-2 text-sm text-slate-600"><span>ID: {selectedEdit.editId || selectedEdit.id} | {selectedEdit.osmType}/{selectedEdit.osmId}</span><span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {selectedStatusMeta.cls}">{selectedStatusMeta.text}</span></p>
            <div class="max-h-[42vh] space-y-2 overflow-auto rounded-xl border border-slate-200 p-2">{#if !Array.isArray(selectedEdit.changes) || selectedEdit.changes.length===0}<p class="text-sm text-slate-500">{$t('admin.edits.noChanges')}</p>{:else}{#each selectedEdit.changes as ch (`${ch.field}`)}<div class="rounded-lg border border-slate-200 bg-slate-50 p-2"><div class="mb-1 flex items-center justify-between gap-2"><p class="text-sm font-semibold text-slate-900">{ch.label || ch.field}</p><div class="flex items-center gap-1"><button type="button" class="ui-btn ui-btn-xs" class:ui-btn-primary={fieldDecisions[ch.field] !== 'reject'} class:ui-btn-secondary={fieldDecisions[ch.field] === 'reject'} on:click={() => (fieldDecisions = { ...fieldDecisions, [ch.field]: 'accept' })}>{$t('admin.edits.accept')}</button><button type="button" class="ui-btn ui-btn-xs" class:ui-btn-primary={fieldDecisions[ch.field] === 'reject'} class:ui-btn-secondary={fieldDecisions[ch.field] !== 'reject'} on:click={() => (fieldDecisions = { ...fieldDecisions, [ch.field]: 'reject' })}>{$t('admin.edits.reject')}</button></div></div><p class="text-xs text-slate-600"><span class="line-through">{String(ch.osmValue ?? $t('admin.edits.emptyValue'))}</span> -> <strong>{String(ch.localValue ?? $t('admin.edits.emptyValue'))}</strong></p>{#if fieldDecisions[ch.field] !== 'reject'}<input class="ui-field mt-2" value={fieldValues[ch.field] ?? ''} on:input={(e) => (fieldValues = { ...fieldValues, [ch.field]: e.currentTarget.value })} />{/if}</div>{/each}{/if}</div>
            <textarea class="ui-field min-h-[84px]" placeholder={$t('admin.edits.moderatorComment')} bind:value={moderationComment}></textarea>
            <div class="flex flex-wrap gap-2"><button type="button" class="ui-btn ui-btn-secondary" on:click={() => setAll('accept')}>{$t('admin.edits.acceptAll')}</button><button type="button" class="ui-btn ui-btn-secondary" on:click={() => setAll('reject')}>{$t('admin.edits.rejectAll')}</button><button type="button" class="ui-btn ui-btn-primary" disabled={moderationBusy} on:click={() => applyDecision('apply')}>{$t('admin.edits.applyDecision')}</button><button type="button" class="ui-btn ui-btn-danger" disabled={moderationBusy} on:click={() => applyDecision('reject')}>{$t('admin.edits.rejectEdit')}</button></div>
            {#if detailStatus}<p class="text-sm text-slate-600">{detailStatus}</p>{/if}
          {/if}
        </section>
        {/if}
      </div>
    {/if}
  </PortalFrame>
{/if}

