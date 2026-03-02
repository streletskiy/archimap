<script>
  import { onMount, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import maplibregl from 'maplibre-gl';
  import { Protocol } from 'pmtiles';
  import { session, setSession } from '$lib/stores/auth';
  import { apiJson } from '$lib/services/http';
  import { getRuntimeConfig } from '$lib/services/config';

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
  let editsStatus = 'Загрузка...';
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
  let protocol = null;
  const centerByKey = new Map();
  const editIdByKey = new Map();

  $: if ($session.authenticated) {
    firstName = String($session.user?.firstName || '');
    lastName = String($session.user?.lastName || '');
    email = String($session.user?.email || '');
  }

  const msg = (e, f) => String(e?.message || f);
  const fmt = (v) => {
    const t = String(v || '').trim();
    if (!t) return '-';
    const d = new Date(t);
    return Number.isFinite(d.getTime()) ? d.toLocaleString() : t;
  };

  function statusBadgeMeta(status) {
    const s = String(status || '').trim().toLowerCase();
    if (s === 'accepted') return { text: 'Принято', cls: 'bg-emerald-100 text-emerald-700' };
    if (s === 'partially_accepted') return { text: 'Частично принято', cls: 'bg-blue-50 text-blue-700' };
    if (s === 'rejected') return { text: 'Отклонено', cls: 'bg-rose-100 text-rose-700' };
    if (s === 'superseded') return { text: 'Заменено новой правкой', cls: 'bg-slate-100 text-slate-700' };
    return { text: 'На рассмотрении', cls: 'bg-amber-100 text-amber-700' };
  }

  function keyOf(item) {
    const t = String(item?.osmType || '').trim();
    const id = Number(item?.osmId || 0);
    return ['way', 'relation'].includes(t) && Number.isInteger(id) && id > 0 ? `${t}/${id}` : null;
  }

  function getEditAddress(item) {
    if (item?.values?.address) return String(item.values.address);
    if (item?.local?.address) return String(item.local.address);
    const changes = Array.isArray(item?.changes) ? item.changes : [];
    const addressChange = changes.find((change) => change?.field === 'address');
    if (addressChange?.localValue) return String(addressChange.localValue);
    if (addressChange?.osmValue) return String(addressChange.osmValue);
    return `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`;
  }

  function getChangeCounters(changes) {
    const list = Array.isArray(changes) ? changes : [];
    let created = 0;
    let modified = 0;
    for (const change of list) {
      if (change?.osmValue == null && change?.localValue != null) created += 1;
      else modified += 1;
    }
    return { total: list.length, created, modified };
  }

  function parseKey(key) {
    const [osmType, idRaw] = String(key || '').split('/');
    const osmId = Number(idRaw);
    return ['way', 'relation'].includes(osmType) && Number.isInteger(osmId) && osmId > 0 ? { osmType, osmId } : null;
  }

  function styleByTheme() {
    return String(document.documentElement?.getAttribute('data-theme') || '').toLowerCase() === 'dark' ? DARK : LIGHT;
  }

  function centerFromGeometry(geometry) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    const walk = (c) => {
      if (!Array.isArray(c)) return;
      if (c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number') {
        minX = Math.min(minX, c[0]); minY = Math.min(minY, c[1]); maxX = Math.max(maxX, c[0]); maxY = Math.max(maxY, c[1]); return;
      }
      for (const x of c) walk(x);
    };
    walk(geometry?.coordinates);
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return [(minX + maxX) / 2, (minY + maxY) / 2];
  }

  function boundsFromGeometry(geometry) {
    const bounds = new maplibregl.LngLatBounds();
    let hasPoint = false;
    const walk = (c) => {
      if (!Array.isArray(c)) return;
      if (c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number') {
        bounds.extend([c[0], c[1]]);
        hasPoint = true;
        return;
      }
      for (const x of c) walk(x);
    };
    walk(geometry?.coordinates);
    return hasPoint ? bounds : null;
  }

  function focusMapOnFeature(feature) {
    if (!map || !feature?.geometry) return;
    const bounds = boundsFromGeometry(feature.geometry);
    if (!bounds || bounds.isEmpty()) return;
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const isPoint = Math.abs(sw.lng - ne.lng) < 1e-8 && Math.abs(sw.lat - ne.lat) < 1e-8;
    if (isPoint) {
      map.easeTo({ center: [sw.lng, sw.lat], zoom: 15, duration: 450 });
      return;
    }
    map.fitBounds(bounds, { padding: 80, duration: 450, maxZoom: 15 });
  }

  function fitAllEdited() {
    if (!map) return;
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

  function ensureMap() {
    if (map || !mapEl) return;
    if (!protocol) {
      protocol = new Protocol();
      maplibregl.addProtocol('pmtiles', protocol.tile);
    }
    const cfg = getRuntimeConfig();
    const pmtilesUrl = cfg.buildingsPmtiles.url.startsWith('http')
      ? cfg.buildingsPmtiles.url
      : `${window.location.origin}${cfg.buildingsPmtiles.url.startsWith('/') ? '' : '/'}${cfg.buildingsPmtiles.url}`;
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
    if (!map) return;
    map.remove();
    map = null;
  }

  function applyMapData() {
    if (!map || !map.getSource(SRC)) return;
    const features = [];
    const ids = [];
    for (const item of visibleEdits) {
      const key = keyOf(item);
      if (!key) continue;
      const c = centerByKey.get(key);
      if (c) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { osmKey: key, editId: Number(item.id || item.editId || 0) } });
      const p = parseKey(key);
      if (p) ids.push((p.osmId * 2) + (p.osmType === 'relation' ? 1 : 0));
    }
    map.getSource(SRC).setData({ type: 'FeatureCollection', features });
    if (map.getLayer('edited-fill')) map.setFilter('edited-fill', ['in', ['id'], ['literal', ids]]);
    if (map.getLayer('edited-line')) map.setFilter('edited-line', ['in', ['id'], ['literal', ids]]);
  }

  async function loadCenters(items) {
    for (const item of items) {
      const key = keyOf(item);
      if (!key || centerByKey.has(key)) continue;
      const p = parseKey(key);
      if (!p) continue;
      try {
        const f = await apiJson(`/api/building/${encodeURIComponent(p.osmType)}/${encodeURIComponent(p.osmId)}`);
        const c = centerFromGeometry(f?.geometry);
        if (c) centerByKey.set(key, c);
      } catch {}
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    profileStatus = 'Сохраняем...';
    try {
      const data = await apiJson('/api/account/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: String(firstName || '').trim(), lastName: String(lastName || '').trim() })
      });
      if (data?.user) setSession({ ...$session, user: { ...$session.user, ...data.user } });
      profileStatus = 'Профиль сохранен';
    } catch (e) {
      profileStatus = msg(e, 'Не удалось сохранить профиль');
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    if (!currentPassword || !newPassword) { passwordStatus = 'Введите текущий и новый пароль'; return; }
    if (newPassword !== confirmNewPassword) { passwordStatus = 'Новые пароли не совпадают'; return; }
    passwordStatus = 'Меняем пароль...';
    try {
      await apiJson('/api/account/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      currentPassword = ''; newPassword = ''; confirmNewPassword = '';
      passwordStatus = 'Пароль успешно изменен';
    } catch (e) {
      passwordStatus = msg(e, 'Не удалось сменить пароль');
    }
  }

  async function loadEdits() {
    editsLoading = true;
    editsStatus = 'Загрузка...';
    try {
      const p = new URLSearchParams();
      if (editsFilter !== 'all') p.set('status', editsFilter);
      p.set('limit', String(editsLimit));
      const data = await apiJson(`/api/account/edits?${p.toString()}`);
      edits = Array.isArray(data?.items) ? data.items : [];
      visibleEdits = [...edits];
      editIdByKey.clear();
      for (const item of visibleEdits) {
        const key = keyOf(item);
        if (key) editIdByKey.set(key, Number(item.id || item.editId || 0));
      }
      await loadCenters(visibleEdits);
      ensureMap();
      applyMapData();
      fitAllEdited();
      editsStatus = visibleEdits.length ? `Показано: ${visibleEdits.length} из ${edits.length}` : 'Правки не найдены';
    } catch (e) {
      edits = [];
      editsStatus = msg(e, 'Не удалось загрузить правки');
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
    detailStatus = 'Загрузка...';
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
      detailStatus = msg(e, 'Не удалось загрузить детали');
      selectedEdit = null;
    } finally {
      if (requestToken === detailRequestToken) detailLoading = false;
    }
  }

  function closeEditPanel() {
    detailRequestToken += 1;
    detailPaneVisible = false;
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
      ensureMap();
      map?.resize();
      applyMapData();
      fitAllEdited();
      if (!edits.length && !editsLoading) await loadEdits();
      return;
    }
    detailPaneVisible = false;
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
      const key = keyOf(item);
      if (key) editIdByKey.set(key, Number(item.id || item.editId || 0));
    }
    if (map) {
      applyMapData();
      fitAllEdited();
    }
    editsStatus = editsLoading ? 'Загрузка...' : `Показано: ${visibleEdits.length} из ${edits.length}`;
  }

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
  <main class="w-full px-3 pb-5 pt-[5.5rem] sm:px-4 sm:pb-6 sm:pt-[5.25rem]"><section class="rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-soft backdrop-blur-sm"><h1 class="text-xl font-extrabold text-slate-900">Требуется вход</h1><p class="mt-2 text-sm text-slate-600">Для просмотра личного кабинета авторизуйтесь через кнопку «Войти» в шапке.</p></section></main>
{:else}
  <section class="page-with-edit-pane w-full px-3 pb-5 pt-[5.5rem] sm:px-4 sm:pb-6 sm:pt-[5.25rem]">
    <section class="rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-soft backdrop-blur-sm sm:p-5">
      <div class="border-b border-slate-200 pb-4"><h1 class="text-2xl font-extrabold">Личный кабинет</h1><p class="mt-1 text-sm text-slate-600">Настройки профиля и история правок.</p></div>
      <ul class="ui-tab-shell mt-4 flex flex-wrap gap-1" role="tablist"><li><button type="button" class="ui-tab-btn" class:ui-tab-btn-active={activeTab === 'settings'} on:click={() => switchTab('settings')}>Настройки</button></li><li><button type="button" class="ui-tab-btn" class:ui-tab-btn-active={activeTab === 'edits'} on:click={() => switchTab('edits')}>Мои правки</button></li></ul>
      {#if activeTab === 'settings'}
        <div class="mt-4 grid gap-4 xl:grid-cols-3">
          <section class="rounded-2xl border border-slate-200 bg-slate-50 p-4"><h3 class="text-base font-bold text-slate-900">Личные данные</h3><form class="mt-4 space-y-4" on:submit={saveProfile}><div><label for="account-first-name" class="mb-1 block text-sm font-medium text-slate-700">Имя</label><input id="account-first-name" class="ui-field bg-white" bind:value={firstName} /></div><div><label for="account-last-name" class="mb-1 block text-sm font-medium text-slate-700">Фамилия</label><input id="account-last-name" class="ui-field bg-white" bind:value={lastName} /></div><div><label for="account-email" class="mb-1 block text-sm font-medium text-slate-700">Email</label><input id="account-email" class="ui-field bg-white text-slate-500" readonly value={email} /></div><button type="submit" class="ui-btn ui-btn-primary">Сохранить</button></form>{#if profileStatus}<p class="mt-3 text-sm text-slate-600">{profileStatus}</p>{/if}</section>
          <section class="rounded-2xl border border-slate-200 bg-slate-50 p-4"><h3 class="text-base font-bold text-slate-900">Безопасность</h3><form class="mt-4 space-y-4" on:submit={changePassword}><input type="password" class="ui-field bg-white" placeholder="Текущий пароль" bind:value={currentPassword} required /><input type="password" class="ui-field bg-white" placeholder="Новый пароль" bind:value={newPassword} required /><input type="password" class="ui-field bg-white" placeholder="Повторите новый пароль" bind:value={confirmNewPassword} required /><button type="submit" class="ui-btn ui-btn-outline-brand">Изменить пароль</button></form>{#if passwordStatus}<p class="mt-3 text-sm text-slate-600">{passwordStatus}</p>{/if}</section>
          <section class="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h3 class="text-base font-bold text-slate-900">Уведомления</h3>
            <div class="mt-4 space-y-4">
              <div class="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
                <div>
                  <p class="text-sm font-semibold text-slate-900">Новые комментарии к правкам</p>
                  <p class="mt-1 text-sm text-slate-500">Письмо, когда администратор комментирует вашу правку.</p>
                </div>
                <label class="relative inline-flex cursor-not-allowed items-center opacity-60">
                  <input type="checkbox" class="peer sr-only" disabled aria-disabled="true" />
                  <div class="h-6 w-11 rounded-full bg-slate-300 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-slate-300 after:bg-white after:transition-all peer-checked:bg-brand-purple peer-checked:after:translate-x-full peer-checked:after:border-white"></div>
                </label>
              </div>
              <div class="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
                <div>
                  <p class="text-sm font-semibold text-slate-900">Статус модерации</p>
                  <p class="mt-1 text-sm text-slate-500">Уведомления об одобрении или отклонении изменений.</p>
                </div>
                <label class="relative inline-flex cursor-not-allowed items-center opacity-60">
                  <input type="checkbox" class="peer sr-only" disabled aria-disabled="true" />
                  <div class="h-6 w-11 rounded-full bg-slate-300 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-slate-300 after:bg-white after:transition-all peer-checked:bg-brand-purple peer-checked:after:translate-x-full peer-checked:after:border-white"></div>
                </label>
              </div>
              <div class="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
                <div>
                  <p class="text-sm font-semibold text-slate-900">Еженедельная сводка</p>
                  <p class="mt-1 text-sm text-slate-500">Подборка ваших активностей и новых объектов на карте.</p>
                </div>
                <label class="relative inline-flex cursor-not-allowed items-center opacity-60">
                  <input type="checkbox" class="peer sr-only" disabled aria-disabled="true" />
                  <div class="h-6 w-11 rounded-full bg-slate-300 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-slate-300 after:bg-white after:transition-all peer-checked:bg-brand-purple peer-checked:after:translate-x-full peer-checked:after:border-white"></div>
                </label>
              </div>
            </div>
          </section>
          <section class="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h3 class="text-base font-bold text-slate-900">Правовая информация</h3>
            <p class="mt-1 text-sm text-slate-600">Соглашения и политика конфиденциальности доступны в разделе информации.</p>
            <div class="mt-4 space-y-2">
              <a href="/info/?tab=user-agreement" class="block rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-indigo-700 underline underline-offset-2 hover:bg-slate-50">Пользовательское соглашение</a>
              <a href="/info/?tab=privacy-policy" class="block rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-indigo-700 underline underline-offset-2 hover:bg-slate-50">Политика конфиденциальности</a>
            </div>
          </section>
        </div>
      {:else}
        <div class="mt-4 grid gap-4 overflow-x-hidden" class:lg:grid-cols-[1.1fr_1fr]={detailPaneVisible || detailLoading || Boolean(selectedEdit) || Boolean(detailStatus)} class:lg:grid-cols-1={!(detailPaneVisible || detailLoading || Boolean(selectedEdit) || Boolean(detailStatus))}>
          <section class="space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
            <div class="grid gap-2 lg:grid-cols-[1.6fr_repeat(2,minmax(0,1fr))]"><input class="ui-field" type="search" placeholder="Поиск по адресу или ID здания" bind:value={editsQuery} /><input class="ui-field" type="date" bind:value={editsDate} /><div class="flex gap-2"><select class="ui-field ui-field-xs" bind:value={editsFilter} on:change={loadEdits}><option value="all">Все</option><option value="pending">На рассмотрении</option><option value="accepted">Принятые</option><option value="partially_accepted">Частично принятые</option><option value="rejected">Отклоненные</option><option value="superseded">Замененные</option></select><select class="ui-field ui-field-xs" bind:value={editsLimit} on:change={loadEdits}><option value={100}>100</option><option value={200}>200</option><option value={500}>500</option></select><button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" on:click={loadEdits}>Обновить</button></div></div>
            <p class="text-sm text-slate-600">{editsStatus}</p>
            <div class="h-[36vh] min-h-[260px] overflow-hidden rounded-xl border border-slate-200" bind:this={mapEl}></div>
            <div class="overflow-x-auto rounded-xl border border-slate-200">
              <table class="min-w-full text-sm">
                <thead>
                  <tr class="border-b border-slate-200 text-left text-slate-600">
                    <th class="px-3 py-2">Объект</th>
                    <th class="px-3 py-2">Автор</th>
                    <th class="px-3 py-2">Статус</th>
                    <th class="px-3 py-2">Изменения тегов</th>
                  </tr>
                </thead>
                <tbody>
                  {#if editsLoading}
                    <tr><td colspan="4" class="px-3 py-3 text-slate-500">Загрузка...</td></tr>
                  {:else if visibleEdits.length===0}
                    <tr><td colspan="4" class="px-3 py-3 text-slate-500">Пусто</td></tr>
                  {:else}
                    {#each visibleEdits as it (`${it.id || it.editId}`)}
                      {@const statusMeta = statusBadgeMeta(it.status)}
                      {@const counters = getChangeCounters(it.changes)}
                      <tr class="cursor-pointer border-b border-slate-100 hover:bg-slate-50" on:click={() => openEdit(it.id || it.editId)}>
                        <td class="px-3 py-2"><p class="font-semibold text-slate-900">{getEditAddress(it)}</p><p class="text-xs text-slate-500">ID: {it.osmType}/{it.osmId}</p>{#if String(it?.adminComment || '').trim()}<p class="mt-1 text-xs text-rose-600">Комментарий: {String(it.adminComment).trim()}</p>{/if}</td>
                        <td class="px-3 py-2">{it.updatedBy || '-'}</td>
                        <td class="px-3 py-2"><span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {statusMeta.cls}">{statusMeta.text}</span></td>
                        <td class="px-3 py-2"><div class="flex flex-wrap items-center gap-2"><span class="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{counters.total} всего</span>{#if counters.created > 0}<span class="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-600">+{counters.created} создано</span>{/if}{#if counters.modified > 0}<span class="rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-600">~{counters.modified} изменено</span>{/if}</div></td>
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
              <h3 class="text-base font-bold text-slate-900">Детали правки</h3>
              <button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" aria-label="Закрыть панель правки" on:click={closeEditPanel}>×</button>
            </div>
            {#if detailLoading}
              <p class="text-sm text-slate-500">Загрузка...</p>
            {:else if !selectedEdit}
              <p class="text-sm text-slate-500">Выберите правку в таблице или на карте.</p>
            {:else}
              {@const selectedStatusMeta = statusBadgeMeta(selectedEdit.status)}
              <p class="flex flex-wrap items-center gap-2 text-sm text-slate-600"><span>ID: {selectedEdit.editId || selectedEdit.id} | {selectedEdit.osmType}/{selectedEdit.osmId}</span><span class="badge-pill rounded-full px-2.5 py-1 text-xs font-semibold {selectedStatusMeta.cls}">{selectedStatusMeta.text}</span></p>
              <div class="max-h-[42vh] space-y-2 overflow-auto rounded-xl border border-slate-200 p-2">
                {#if !Array.isArray(selectedEdit.changes) || selectedEdit.changes.length === 0}
                  <p class="text-sm text-slate-500">Без изменений</p>
                {:else}
                  {#each selectedEdit.changes as ch (`${ch.field}`)}
                    <div class="rounded-lg border border-slate-200 bg-slate-50 p-2"><p class="text-sm font-semibold text-slate-900">{ch.label || ch.field}</p><p class="text-xs text-slate-600"><span class="line-through">{String(ch.osmValue ?? 'пусто')}</span> -> <strong>{String(ch.localValue ?? 'пусто')}</strong></p></div>
                  {/each}
                {/if}
              </div>
              {#if detailStatus}<p class="text-sm text-slate-600">{detailStatus}</p>{/if}
            {/if}
          </section>
          {/if}
        </div>
      {/if}
    </section>
  </section>
{/if}
