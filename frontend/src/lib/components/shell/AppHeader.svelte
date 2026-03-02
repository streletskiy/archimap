<script>
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/stores';
  import { clearSession, session, setSession } from '$lib/stores/auth';
  import { apiJson } from '$lib/services/http';
  import { resetBuildingFilterRules, setBuildingFilterRules } from '$lib/stores/filters';
  import { openSearchModal, requestSearch, resetSearchState, setSearchQuery, searchState } from '$lib/stores/search';
  import { mapLabelsVisible, setMapLabelsVisible } from '$lib/stores/map';

  let loginEmail = '';
  let loginPassword = '';
  let regEmail = '';
  let regPassword = '';
  let regPasswordConfirm = '';
  let regFirstName = '';
  let regLastName = '';
  let regCode = '';
  let regAcceptTerms = false;
  let regAcceptPrivacy = false;
  let registerPendingEmail = '';
  let resetEmail = '';
  let resetToken = '';
  let resetNewPassword = '';

  let status = '';
  let darkTheme = false;
  let menuOpen = false;
  let authOpen = false;
  let authTab = 'login';
  let resetMode = false;
  let filterOpen = false;
  let filterRows = [{ id: 1, key: '', op: 'contains', value: '' }];
  let filterTagKeys = [];
  let filterTagKeysRetryTimer = null;
  let searchText = '';

  const FILTER_TAG_LABELS_RU = Object.freeze({
    architect: 'Архитектор',
    'building:architecture': 'Архитектурный стиль',
    style: 'Стиль',
    year_built: 'Год постройки',
    year_of_construction: 'Год строительства',
    start_date: 'Дата постройки',
    'building:start_date': 'Дата начала строительства',
    'building:year': 'Год',
    'building:levels': 'Этажность',
    levels: 'Этажей',
    'building:colour': 'Цвет здания',
    'building:material': 'Материал здания',
    'building:height': 'Высота здания',
    'roof:colour': 'Цвет крыши',
    'roof:shape': 'Форма крыши',
    'roof:levels': 'Уровни крыши',
    'roof:orientation': 'Ориентация крыши',
    height: 'Высота',
    colour: 'Цвет',
    material: 'Материал',
    name: 'Название',
    'name:ru': 'Название (RU)',
    'name:en': 'Название (EN)',
    address: 'Адрес',
    'addr:full': 'Полный адрес',
    'addr:city': 'Город',
    'addr:street': 'Улица',
    'addr:housenumber': 'Номер дома',
    'addr:postcode': 'Индекс',
    amenity: 'Тип объекта',
    building: 'Тип здания'
  });

  const PRIORITY_FILTER_TAG_KEYS = Object.freeze([
    'architect',
    'building:architecture',
    'style',
    'year_built',
    'year_of_construction',
    'start_date',
    'building:start_date',
    'building:year',
    'building:levels',
    'levels'
  ]);

  const APPEARANCE_FILTER_TAG_KEYS = Object.freeze([
    'building:colour',
    'building:material',
    'building:height',
    'roof:colour',
    'roof:shape',
    'roof:levels',
    'roof:orientation',
    'height',
    'colour',
    'material'
  ]);

  const APPEARANCE_FILTER_TAG_PREFIXES = Object.freeze([
    'roof:',
    'facade:',
    'building:facade',
    'building:cladding',
    'building:colour',
    'building:material',
    'building:height',
    'building:shape'
  ]);

  $: currentPathname = $page.url.pathname;
  $: basePrefix = currentPathname === '/app' || currentPathname.startsWith('/app/') ? '/app' : '';
  $: normalizedPathname = basePrefix ? (currentPathname.slice(basePrefix.length) || '/') : currentPathname;

  function navHref(path) {
    const target = path === '/' ? '' : path;
    return `${basePrefix}${target || '/'}`;
  }

  function isActive(pathname, href) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  async function loadMe() {
    try {
      const data = await apiJson('/api/me');
      setSession(data);
    } catch {
      clearSession();
    }
  }

  function openAuth(tab = 'login') {
    authTab = tab;
    resetMode = false;
    authOpen = true;
    menuOpen = false;
  }

  function addFilterRow() {
    const nextId = Math.max(0, ...filterRows.map((row) => Number(row.id) || 0)) + 1;
    filterRows = [...filterRows, { id: nextId, key: '', op: 'contains', value: '' }];
  }

  function updateFilterRow(id, patch) {
    filterRows = filterRows.map((row) => (row.id === id ? { ...row, ...patch } : row));
  }

  function removeFilterRow(id) {
    if (filterRows.length <= 1) {
      filterRows = [{ id: 1, key: '', op: 'contains', value: '' }];
      return;
    }
    filterRows = filterRows.filter((row) => row.id !== id);
  }

  function applyFilters() {
    setBuildingFilterRules(filterRows);
  }

  function resetFilters() {
    filterRows = [{ id: 1, key: '', op: 'contains', value: '' }];
    resetBuildingFilterRules();
  }

  function closeAuth() {
    authOpen = false;
  }

  function closeFloatingPanels() {
    menuOpen = false;
    filterOpen = false;
  }

  function getFilterTagDisplayName(tagKey) {
    const key = String(tagKey || '').trim();
    if (!key) return '';
    return FILTER_TAG_LABELS_RU[key] || key;
  }

  function getFilterTagGroupRank(tagKey) {
    const key = String(tagKey || '').trim();
    if (!key) return 2;
    if (PRIORITY_FILTER_TAG_KEYS.includes(key)) return 0;
    if (APPEARANCE_FILTER_TAG_KEYS.includes(key)) return 1;
    if (APPEARANCE_FILTER_TAG_PREFIXES.some((prefix) => key.startsWith(prefix))) return 1;
    return 2;
  }

  function sortFilterTagKeys(keys) {
    return [...new Set((Array.isArray(keys) ? keys : []).map((k) => String(k || '').trim()).filter(Boolean))]
      .sort((a, b) => {
        const aGroup = getFilterTagGroupRank(a);
        const bGroup = getFilterTagGroupRank(b);
        if (aGroup !== bGroup) return aGroup - bGroup;
        const aLabel = getFilterTagDisplayName(a);
        const bLabel = getFilterTagDisplayName(b);
        return aLabel.localeCompare(bLabel, 'ru');
      });
  }

  function scheduleFilterTagKeysRetry(delayMs = 1500) {
    if (filterTagKeysRetryTimer) {
      clearTimeout(filterTagKeysRetryTimer);
    }
    filterTagKeysRetryTimer = setTimeout(() => {
      filterTagKeysRetryTimer = null;
      loadFilterTagKeys();
    }, delayMs);
  }

  async function loadFilterTagKeys() {
    try {
      const payload = await apiJson('/api/filter-tag-keys');
      const keys = Array.isArray(payload?.keys) ? payload.keys : [];
      const warmingUp = Boolean(payload?.warmingUp);
      filterTagKeys = sortFilterTagKeys(keys);
      if (warmingUp && filterTagKeys.length === 0) {
        scheduleFilterTagKeysRetry(1500);
      }
    } catch {
      scheduleFilterTagKeysRetry(2500);
    }
  }

  function submitSearch(event) {
    event.preventDefault();
    const text = String(searchText || '').trim().slice(0, 120);
    setSearchQuery(text);
    openSearchModal(text);
    requestSearch({ query: text, append: false });
  }

  function onSearchInput(event) {
    const text = String(event.currentTarget.value || '').slice(0, 120);
    searchText = text;
    setSearchQuery(text);
    if (String(text).trim().length === 0) {
      resetSearchState('Введите минимум 2 символа.');
    }
  }

  function openMobileSearch() {
    const text = String(searchText || '').trim().slice(0, 120);
    setSearchQuery(text);
    openSearchModal(text);
    if (text.length >= 2) {
      requestSearch({ query: text, append: false });
    }
  }

  async function submitLogin(event) {
    event.preventDefault();
    status = 'Выполняем вход...';
    try {
      const data = await apiJson('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword })
      });
      setSession({ authenticated: true, user: data.user, csrfToken: data.csrfToken });
      status = 'Вход выполнен';
      loginPassword = '';
      closeAuth();
    } catch (error) {
      status = String(error.message || 'Не удалось войти');
    }
  }

  async function submitRegisterStart(event) {
    event.preventDefault();
    const email = String(regEmail || '').trim();
    const password = String(regPassword || '');
    const passwordConfirm = String(regPasswordConfirm || '');

    if (!email) {
      status = 'Укажите email';
      return;
    }
    if (password.length < 8) {
      status = 'Пароль должен содержать минимум 8 символов';
      return;
    }
    if (password !== passwordConfirm) {
      status = 'Пароли не совпадают';
      return;
    }
    if (!regAcceptTerms || !regAcceptPrivacy) {
      status = 'Для регистрации необходимо принять пользовательское соглашение и политику конфиденциальности';
      return;
    }

    status = 'Отправляем код...';
    try {
      const data = await apiJson('/api/register/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          firstName: regFirstName,
          lastName: regLastName,
          acceptTerms: regAcceptTerms,
          acceptPrivacy: regAcceptPrivacy
        })
      });
      if (data?.directSignup) {
        setSession({ authenticated: true, user: data.user, csrfToken: data.csrfToken });
        status = 'Регистрация завершена';
        closeAuth();
        return;
      }
      registerPendingEmail = regEmail;
      status = 'Код отправлен на email';
    } catch (error) {
      status = String(error.message || 'Не удалось запустить регистрацию');
    }
  }

  async function submitRegisterConfirm(event) {
    event.preventDefault();
    status = 'Подтверждаем код...';
    try {
      const data = await apiJson('/api/register/confirm-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: registerPendingEmail, code: regCode })
      });
      setSession({ authenticated: true, user: data.user, csrfToken: data.csrfToken });
      status = 'Регистрация подтверждена';
      closeAuth();
    } catch (error) {
      status = String(error.message || 'Не удалось подтвердить код');
    }
  }

  async function submitResetRequest(event) {
    event.preventDefault();
    status = 'Отправляем письмо для сброса...';
    try {
      await apiJson('/api/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resetEmail })
      });
      status = 'Если email существует, письмо отправлено';
    } catch (error) {
      status = String(error.message || 'Не удалось отправить запрос');
    }
  }

  async function submitResetConfirm(event) {
    event.preventDefault();
    status = 'Сбрасываем пароль...';
    try {
      await apiJson('/api/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword: resetNewPassword })
      });
      status = 'Пароль изменен';
      resetToken = '';
      resetNewPassword = '';
      resetMode = false;
      authTab = 'login';
    } catch (error) {
      status = String(error.message || 'Не удалось изменить пароль');
    }
  }

  async function logout() {
    try {
      await apiJson('/api/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    clearSession();
    menuOpen = false;
  }

  function applyTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    darkTheme = next === 'dark';
    try {
      localStorage.setItem('archimap-theme', next);
    } catch {
      // ignore
    }
  }

  function applyLabelsVisibility(visible) {
    const next = Boolean(visible);
    setMapLabelsVisible(next);
    try {
      localStorage.setItem('archimap-map-labels-visible', next ? '1' : '0');
    } catch {
      // ignore
    }
  }

  onMount(() => {
    loadMe();
    darkTheme = document.documentElement.getAttribute('data-theme') === 'dark';
    searchText = String($searchState.query || '');
    try {
      const storedLabels = localStorage.getItem('archimap-map-labels-visible');
      if (storedLabels === '0' || storedLabels === '1') {
        setMapLabelsVisible(storedLabels === '1');
      }
    } catch {
      // ignore
    }
    loadFilterTagKeys();
  });

  onDestroy(() => {
    if (filterTagKeysRetryTimer) {
      clearTimeout(filterTagKeysRetryTimer);
      filterTagKeysRetryTimer = null;
    }
  });
</script>

<header class="nav-shell">
  <div class="nav">
    <div class="left">
      <a href={navHref('/')} class="logo">archimap</a>
      <button type="button" class="icon-btn" aria-label="Открыть фильтры" on:click={() => (filterOpen = !filterOpen)}>
        <svg viewBox="0 0 512 512" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M3.9 54.9C10.5 40.9 24.5 32 40 32l432 0c15.5 0 29.5 8.9 36.1 22.9s4.6 30.5-5.2 42.5L320 320.9 320 448c0 12.1-6.8 23.2-17.7 28.6s-23.8 4.3-33.5-3l-64-48c-8.1-6-12.8-15.5-12.8-25.6l0-79.1L9 97.3C-.7 85.4-2.8 68.8 3.9 54.9z"/></svg>
      </button>
    </div>

    <form class="search" on:submit={submitSearch}>
      <svg viewBox="0 0 640 640" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M480 272C480 317.9 465.1 360.3 440 394.7L566.6 521.4C579.1 533.9 579.1 554.2 566.6 566.7C554.1 579.2 533.8 579.2 521.3 566.7L394.7 440C360.3 465.1 317.9 480 272 480C157.1 480 64 386.9 64 272C64 157.1 157.1 64 272 64C386.9 64 480 157.1 480 272zM272 416C351.5 416 416 351.5 416 272C416 192.5 351.5 128 272 128C192.5 128 128 192.5 128 272C128 351.5 192.5 416 272 416z"/></svg>
      <input type="search" placeholder="Поиск: название, адрес, стиль, архитектор" bind:value={searchText} on:input={onSearchInput} />
    </form>

    <div class="right-controls">
      <button type="button" class="icon-btn search-mobile-btn" aria-label="Открыть поиск" on:click={openMobileSearch}>
        <svg viewBox="0 0 640 640" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M480 272C480 317.9 465.1 360.3 440 394.7L566.6 521.4C579.1 533.9 579.1 554.2 566.6 566.7C554.1 579.2 533.8 579.2 521.3 566.7L394.7 440C360.3 465.1 317.9 480 272 480C157.1 480 64 386.9 64 272C64 157.1 157.1 64 272 64C386.9 64 480 157.1 480 272zM272 416C351.5 416 416 351.5 416 272C416 192.5 351.5 128 272 128C192.5 128 128 192.5 128 272C128 351.5 192.5 416 272 416z"/></svg>
      </button>
      <button type="button" class="icon-btn menu-btn-trigger" aria-label="Открыть меню" aria-expanded={menuOpen} on:click={() => (menuOpen = !menuOpen)}>
        <svg viewBox="0 0 640 640" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M96 160C96 142.3 110.3 128 128 128L512 128C529.7 128 544 142.3 544 160C544 177.7 529.7 192 512 192L128 192C110.3 192 96 177.7 96 160zM96 320C96 302.3 110.3 288 128 288L512 288C529.7 288 544 302.3 544 320C544 337.7 529.7 352 512 352L128 352C110.3 352 96 337.7 96 320zM544 480C544 497.7 529.7 512 512 512L128 512C110.3 512 96 497.7 96 480C96 462.3 110.3 448 128 448L512 448C529.7 448 544 462.3 544 480z"/></svg>
      </button>
    </div>
  </div>

  {#if menuOpen || filterOpen}
    <button type="button" class="nav-backdrop" aria-label="Закрыть выпадающие панели" on:click={closeFloatingPanels}></button>
  {/if}

  {#if filterOpen}
    <div class="filter-panel">
      <div class="filter-head">
        <h4>Фильтр OSM тегов</h4>
        <button type="button" class="icon-btn icon-btn-sm" aria-label="Закрыть фильтр" on:click={() => (filterOpen = false)}>×</button>
      </div>
      <div class="rows">
        {#each filterRows as row (row.id)}
          <div class="row">
            <input
              class="ui-field ui-field-xs"
              list="filter-tag-keys"
              placeholder="Ключ тега"
              value={row.key}
              on:input={(e) => updateFilterRow(row.id, { key: e.currentTarget.value })}
            />
            <select
              class="ui-field ui-field-xs"
              value={row.op}
              on:change={(e) => updateFilterRow(row.id, { op: e.currentTarget.value })}
            >
              <option value="contains">содержит</option>
              <option value="equals">равно</option>
              <option value="not_equals">не равно</option>
              <option value="starts_with">начинается с</option>
              <option value="exists">существует</option>
              <option value="not_exists">отсутствует</option>
            </select>
            <input
              class="ui-field ui-field-xs"
              placeholder="Значение"
              value={row.value}
              on:input={(e) => updateFilterRow(row.id, { value: e.currentTarget.value })}
              disabled={row.op === 'exists' || row.op === 'not_exists'}
            />
            <button type="button" class="icon-btn icon-btn-sm" aria-label="Удалить строку" on:click={() => removeFilterRow(row.id)}>−</button>
          </div>
        {/each}
      </div>
      <div class="filter-actions">
        <button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" on:click={addFilterRow}>+ Критерий</button>
        <button type="button" class="ui-btn ui-btn-secondary ui-btn-xs" on:click={resetFilters}>Сброс</button>
        <button type="button" class="ui-btn ui-btn-primary ui-btn-xs" on:click={applyFilters}>Применить</button>
      </div>
      <datalist id="filter-tag-keys">
        {#each filterTagKeys as key (key)}
          <option value={key} label={getFilterTagDisplayName(key)}>{getFilterTagDisplayName(key)}</option>
        {/each}
      </datalist>
    </div>
  {/if}

  {#if menuOpen}
    <div class="menu">
      {#if !$session.authenticated}
        <button type="button" class="ui-btn ui-btn-primary menu-btn" on:click={() => openAuth('login')}>Войти</button>
        <button type="button" class="ui-btn ui-btn-secondary menu-btn" on:click={() => openAuth('register')}>Регистрация</button>
      {:else}
        <a href={navHref('/account')} class:active={isActive(normalizedPathname, '/account')} on:click={() => (menuOpen = false)}>Профиль</a>
      {/if}
      <a href={navHref('/info')} class:active={isActive(normalizedPathname, '/info')} on:click={() => (menuOpen = false)}>Информация</a>
      {#if $session.user?.isAdmin}
        <a href={navHref('/admin')} class:active={isActive(normalizedPathname, '/admin')} on:click={() => (menuOpen = false)}>Админ-панель</a>
      {/if}
      <div class="theme-row">
        <span>Обозначения</span>
        <label class="switch switch-icons switch-labels" aria-label={$mapLabelsVisible ? 'Скрыть обозначения карты' : 'Показывать обозначения карты'}>
          <input type="checkbox" checked={$mapLabelsVisible} on:change={(e) => applyLabelsVisibility(e.currentTarget.checked)} />
          <span class="icon-center" aria-hidden="true">
            <svg viewBox="0 0 640 640" width="12" height="12"><path fill="currentColor" d="M349.1 114.7C343.9 103.3 332.5 96 320 96C307.5 96 296.1 103.3 290.9 114.7L123.5 480L112 480C94.3 480 80 494.3 80 512C80 529.7 94.3 544 112 544L200 544C217.7 544 232 529.7 232 512C232 494.3 217.7 480 200 480L193.9 480L215.9 432L424.2 432L446.2 480L440.1 480C422.4 480 408.1 494.3 408.1 512C408.1 529.7 422.4 544 440.1 544L528.1 544C545.8 544 560.1 529.7 560.1 512C560.1 494.3 545.8 480 528.1 480L516.6 480L349.2 114.7zM394.8 368L245.2 368L320 204.8L394.8 368z"/></svg>
          </span>
          <span class="slider"></span>
        </label>
      </div>
      <div class="theme-row">
        <span>Тема</span>
        <label class="switch switch-icons" aria-label="Переключить тему">
          <input type="checkbox" checked={darkTheme} on:change={(e) => applyTheme(e.currentTarget.checked ? 'dark' : 'light')} />
          <span class="icon-on" aria-hidden="true">
            <svg viewBox="0 0 640 640" width="14" height="14"><path fill="currentColor" d="M320 32C328.4 32 336.3 36.4 340.6 43.7L396.1 136.3L500.9 110C509.1 108 517.8 110.4 523.7 116.3C529.6 122.2 532 131 530 139.1L503.7 243.8L596.4 299.3C603.6 303.6 608.1 311.5 608.1 319.9C608.1 328.3 603.7 336.2 596.4 340.5L503.7 396.1L530 500.8C532 509 529.6 517.7 523.7 523.6C517.8 529.5 509 532 500.9 530L396.2 503.7L340.7 596.4C336.4 603.6 328.5 608.1 320.1 608.1C311.7 608.1 303.8 603.7 299.5 596.4L243.9 503.7L139.2 530C131 532 122.4 529.6 116.4 523.7C110.4 517.8 108 509 110 500.8L136.2 396.1L43.6 340.6C36.4 336.2 32 328.4 32 320C32 311.6 36.4 303.7 43.7 299.4L136.3 243.9L110 139.1C108 130.9 110.3 122.3 116.3 116.3C122.3 110.3 131 108 139.2 110L243.9 136.2L299.4 43.6L301.2 41C305.7 35.3 312.6 31.9 320 31.9zM320 176C240.5 176 176 240.5 176 320C176 399.5 240.5 464 320 464C399.5 464 464 399.5 464 320C464 240.5 399.5 176 320 176zM320 416C267 416 224 373 224 320C224 267 267 224 320 224C373 224 416 267 416 320C416 373 373 416 320 416z"/></svg>
          </span>
          <span class="icon-off" aria-hidden="true">
            <svg viewBox="0 0 640 640" width="14" height="14"><path fill="currentColor" d="M320 64C178.6 64 64 178.6 64 320C64 461.4 178.6 576 320 576C388.8 576 451.3 548.8 497.3 504.6C504.6 497.6 506.7 486.7 502.6 477.5C498.5 468.3 488.9 462.6 478.8 463.4C473.9 463.8 469 464 464 464C362.4 464 280 381.6 280 280C280 207.9 321.5 145.4 382.1 115.2C391.2 110.7 396.4 100.9 395.2 90.8C394 80.7 386.6 72.5 376.7 70.3C358.4 66.2 339.4 64 320 64z"/></svg>
          </span>
          <span class="slider"></span>
        </label>
      </div>
      {#if $session.authenticated}
        <button type="button" class="ui-btn ui-btn-danger menu-btn" on:click={logout}>Выйти</button>
      {/if}
    </div>
  {/if}
</header>

{#if authOpen}
  <div class="auth-backdrop" role="button" tabindex="0" on:click={(e) => e.target === e.currentTarget && closeAuth()} on:keydown={(e) => e.key === 'Escape' && closeAuth()}>
    <section class="auth-modal">
      <div class="auth-head">
        <h3>Вход в archimap</h3>
        <button type="button" class="icon-btn" on:click={closeAuth} aria-label="Закрыть">×</button>
      </div>

      {#if registerPendingEmail}
        <form class="stack" on:submit={submitRegisterConfirm}>
          <p class="hint">Подтверждение регистрации</p>
          <input class="ui-field" value={registerPendingEmail} readonly />
          <input class="ui-field" bind:value={regCode} inputmode="numeric" maxlength="6" placeholder="123456" required />
          <button class="ui-btn ui-btn-secondary" type="submit">Подтвердить кодом</button>
        </form>
      {:else if resetMode}
        <form class="stack" on:submit={submitResetRequest}>
          <input class="ui-field" bind:value={resetEmail} type="email" placeholder="Email аккаунта" required />
          <button class="ui-btn ui-btn-secondary" type="submit">Отправить ссылку для сброса</button>
        </form>
        <form class="stack" on:submit={submitResetConfirm}>
          <input class="ui-field" bind:value={resetToken} placeholder="Reset token" required />
          <input class="ui-field" bind:value={resetNewPassword} type="password" placeholder="Новый пароль" required />
          <button class="ui-btn ui-btn-primary" type="submit">Сменить пароль</button>
        </form>
      {:else}
        <div class="tabs ui-tab-shell">
          <button type="button" class="ui-tab-btn" class:ui-tab-btn-active={authTab === 'login'} on:click={() => (authTab = 'login')}>Вход</button>
          <button type="button" class="ui-tab-btn" class:ui-tab-btn-active={authTab === 'register'} on:click={() => (authTab = 'register')}>Регистрация</button>
        </div>

        {#if authTab === 'login'}
          <form class="stack" on:submit={submitLogin}>
            <input class="ui-field" bind:value={loginEmail} type="email" placeholder="Email" required />
            <input class="ui-field" bind:value={loginPassword} type="password" placeholder="Пароль" required />
            <button type="button" class="forgot-btn" on:click={() => (resetMode = true)}>Забыли пароль?</button>
            <button class="ui-btn ui-btn-primary" type="submit">Войти</button>
          </form>
        {:else}
          <form class="stack" on:submit={submitRegisterStart}>
            <input class="ui-field" bind:value={regFirstName} placeholder="Имя (необязательно)" />
            <input class="ui-field" bind:value={regLastName} placeholder="Фамилия (необязательно)" />
            <input class="ui-field" bind:value={regEmail} type="email" placeholder="Email (обязательно)" required aria-required="true" />
            <input class="ui-field" bind:value={regPassword} type="password" placeholder="Пароль (обязательно)" required aria-required="true" />
            <input class="ui-field" bind:value={regPasswordConfirm} type="password" placeholder="Повторите пароль" required />
            <label class="consent">
              <input type="checkbox" bind:checked={regAcceptTerms} required aria-required="true" />
              <span>Принимаю (обязательно) <a href={navHref('/info')} on:click={() => (menuOpen = false)}>пользовательское соглашение</a></span>
            </label>
            <label class="consent">
              <input type="checkbox" bind:checked={regAcceptPrivacy} required aria-required="true" />
              <span>Принимаю (обязательно) <a href={navHref('/info')} on:click={() => (menuOpen = false)}>политику конфиденциальности</a></span>
            </label>
            <button class="ui-btn ui-btn-primary" type="submit">Создать аккаунт</button>
          </form>
        {/if}
      {/if}

      {#if status}
        <p class="status">{status}</p>
      {/if}
    </section>
  </div>
{/if}

<style>
  .nav-shell {
    position: fixed;
    inset-inline: 0;
    top: 0;
    z-index: 930;
    padding: 0.75rem;
    pointer-events: none;
  }
  .nav {
    border: 1px solid #cbd5e1;
    border-radius: 1rem;
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(6px);
    box-shadow: 0 8px 20px rgba(15, 23, 42, 0.06);
    padding: 0.5rem 0.65rem;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: center;
    pointer-events: auto;
    position: relative;
    z-index: 2;
  }
  .left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .logo {
    font-size: 1.7rem;
    font-weight: 800;
    line-height: 1;
    color: #000;
    text-decoration: none;
    padding-inline: 0.25rem;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    border: 1px solid #cbd5e1;
    border-radius: 0.6rem;
    background: #fff;
    padding: 0 0.65rem;
    height: 2.45rem;
  }
  .search input {
    width: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    font-size: 0.9rem;
  }
  .icon-btn {
    width: 2.45rem;
    height: 2.45rem;
    border: 1px solid #cbd5e1;
    border-radius: 0.65rem;
    background: #fff;
    color: #334155;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .right-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    justify-self: end;
  }
  .search-mobile-btn {
    display: none;
  }
  .menu {
    margin-top: 0.35rem;
    margin-left: auto;
    width: min(17rem, calc(100vw - 1.5rem));
    border: 1px solid #cbd5e1;
    border-radius: 0.85rem;
    background: rgba(255, 255, 255, 0.97);
    box-shadow: 0 8px 20px rgba(15, 23, 42, 0.06);
    padding: 0.5rem;
    display: grid;
    gap: 0.35rem;
    pointer-events: auto;
    position: relative;
    z-index: 2;
  }
  .filter-panel {
    margin-top: 0.35rem;
    width: min(30rem, calc(100vw - 1.5rem));
    border: 1px solid #cbd5e1;
    border-radius: 0.85rem;
    background: rgba(255, 255, 255, 0.97);
    box-shadow: 0 8px 20px rgba(15, 23, 42, 0.06);
    padding: 0.6rem;
    display: grid;
    gap: 0.5rem;
    pointer-events: auto;
    position: relative;
    z-index: 2;
  }
  .nav-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1;
    border: 0;
    margin: 0;
    padding: 0;
    background: transparent;
  }
  .filter-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .filter-head h4 {
    margin: 0;
    font-size: 0.96rem;
    font-weight: 800;
    color: #0f172a;
  }
  .rows {
    display: grid;
    gap: 0.35rem;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr) minmax(0, 1.1fr) auto;
    gap: 0.35rem;
    align-items: center;
  }
  .filter-actions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .icon-btn-sm {
    width: 1.9rem;
    height: 1.9rem;
    border-radius: 0.5rem;
  }
  .menu a {
    text-decoration: none;
    font-size: 0.92rem;
    color: #334155;
    padding: 0.5rem 0.6rem;
    border-radius: 0.6rem;
    font-weight: 600;
  }
  .menu a.active {
    background: #f1f5f9;
    color: #0f172a;
  }
  .menu-btn {
    width: 100%;
  }
  .theme-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border: 1px solid #e2e8f0;
    border-radius: 0.6rem;
    background: #f8fafc;
    padding: 0.4rem 0.55rem;
    font-size: 0.9rem;
    font-weight: 600;
    color: #334155;
  }
  .switch {
    position: relative;
    --switch-width: 2.8rem;
    --switch-height: 1.55rem;
    --switch-pad: 0.16rem;
    --knob-size: 1.2rem;
    width: var(--switch-width);
    height: var(--switch-height);
    display: inline-flex;
  }
  .switch-icons {
    --switch-width: 4.75rem;
    width: var(--switch-width);
  }
  .switch-icons .icon-on,
  .switch-icons .icon-off {
    position: absolute;
    top: 50%;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--knob-size);
    height: var(--knob-size);
    transform: translateY(-50%);
    color: #334155;
    transition: color 0.2s, opacity 0.2s;
    pointer-events: none;
  }
  .switch-icons .icon-on {
    left: calc(var(--switch-pad) + 0.03rem);
    color: #1f2937;
  }
  .switch-icons .icon-off {
    right: calc(var(--switch-pad) + 0.03rem);
    opacity: 0.9;
  }
  .switch-icons .icon-center {
    position: absolute;
    left: calc(var(--switch-pad) + 0.03rem);
    top: 50%;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--knob-size);
    height: var(--knob-size);
    color: #334155;
    transform: translateY(-50%);
    transition: transform 0.2s, color 0.2s;
    pointer-events: none;
  }
  .switch-labels input:checked ~ .icon-center {
    transform: translate(
      calc(var(--switch-width) - var(--knob-size) - (var(--switch-pad) * 2)),
      -50%
    );
    color: #1f2937;
  }
  .switch input {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    cursor: pointer;
  }
  .slider {
    position: absolute;
    inset: 0;
    border-radius: 999px;
    background: #cbd5e1;
    transition: 0.2s;
  }
  .slider::before {
    content: '';
    position: absolute;
    width: var(--knob-size);
    height: var(--knob-size);
    left: var(--switch-pad);
    top: 50%;
    border-radius: 50%;
    background: #fff;
    transform: translateY(-50%);
    transition: 0.2s;
  }
  .switch-icons input:checked ~ .slider {
    background: #6366f1;
  }
  .switch-icons input:checked ~ .slider::before {
    transform: translate(
      calc(var(--switch-width) - var(--knob-size) - (var(--switch-pad) * 2)),
      -50%
    );
  }
  .switch-icons input:checked ~ .icon-on {
    color: #1f2937;
  }
  .switch-icons input:checked ~ .icon-off {
    color: #1f2937;
  }
  .auth-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1200;
    background: rgba(15, 23, 42, 0.35);
    backdrop-filter: blur(2px);
    display: grid;
    place-items: center;
    padding: 1rem;
  }
  .auth-modal {
    width: min(31rem, 100%);
    border: 1px solid #e2e8f0;
    border-radius: 1rem;
    background: #fff;
    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.12);
    padding: 1rem;
  }
  .auth-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }
  .auth-head h3 {
    margin: 0;
  }
  .tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.25rem;
    margin-bottom: 0.6rem;
  }
  .stack {
    display: grid;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .forgot-btn {
    border: 0;
    background: transparent;
    text-align: right;
    color: #4f46e5;
    font-weight: 600;
    font-size: 0.78rem;
    cursor: pointer;
    padding: 0;
  }
  .hint {
    margin: 0 0 0.2rem;
    color: #0f172a;
    font-weight: 700;
    font-size: 0.9rem;
  }
  .status {
    margin: 0.25rem 0 0;
    font-size: 0.8rem;
    color: #64748b;
  }

  .consent {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: #334155;
  }

  .consent input {
    margin-top: 0.1rem;
  }

  .consent a {
    color: #4f46e5;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  :global(html[data-theme='dark']) .nav {
    border-color: #334155;
    background: rgba(15, 23, 42, 0.92);
    box-shadow: 0 10px 24px rgba(2, 6, 23, 0.5);
  }

  :global(html[data-theme='dark']) .logo {
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .search {
    border-color: #334155;
    background: #111a2d;
  }

  :global(html[data-theme='dark']) .search input {
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .search input::placeholder {
    color: #94a3b8;
  }

  :global(html[data-theme='dark']) .icon-btn {
    border-color: #334155;
    background: #111a2d;
    color: #cbd5e1;
  }

  :global(html[data-theme='dark']) .icon-btn:hover {
    background: #18233a;
    color: #f1f5f9;
  }

  :global(html[data-theme='dark']) .menu,
  :global(html[data-theme='dark']) .filter-panel {
    border-color: #334155;
    background: rgba(15, 23, 42, 0.96);
    box-shadow: 0 12px 28px rgba(2, 6, 23, 0.62);
  }

  :global(html[data-theme='dark']) .filter-head h4 {
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .menu a {
    color: #cbd5e1;
  }

  :global(html[data-theme='dark']) .menu a:hover {
    background: #18233a;
  }

  :global(html[data-theme='dark']) .menu a.active {
    background: #1e293b;
    color: #f8fafc;
  }

  :global(html[data-theme='dark']) .theme-row {
    border-color: #334155;
    background: #0f172a;
    color: #cbd5e1;
  }

  :global(html[data-theme='dark']) .slider {
    background: #475569;
  }

  :global(html[data-theme='dark']) .switch-icons .icon-on,
  :global(html[data-theme='dark']) .switch-icons .icon-off,
  :global(html[data-theme='dark']) .switch-icons .icon-center {
    color: #cbd5e1;
  }
  :global(html[data-theme='dark']) .switch-icons input:checked ~ .icon-off {
    color: #1f2937;
  }

  :global(html[data-theme='dark']) .switch-labels .icon-center {
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .switch-labels input:checked ~ .icon-center {
    color: #1f2937;
  }

  :global(html[data-theme='dark']) .auth-backdrop {
    background: rgba(2, 6, 23, 0.72);
  }

  :global(html[data-theme='dark']) .auth-modal {
    border-color: #334155;
    background: #111a2d;
    box-shadow: 0 20px 40px rgba(2, 6, 23, 0.62);
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .auth-head h3,
  :global(html[data-theme='dark']) .hint {
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .status {
    color: #94a3b8;
  }

  :global(html[data-theme='dark']) .forgot-btn {
    color: #a5b4fc;
  }

  :global(html[data-theme='dark']) .consent {
    color: #cbd5e1;
  }

  :global(html[data-theme='dark']) .consent a {
    color: #a5b4fc;
  }
  @media (max-width: 768px) {
    .search {
      display: none;
    }
    .search-mobile-btn {
      display: inline-flex;
    }
    .nav {
      grid-template-columns: auto 1fr auto;
    }
    .row {
      grid-template-columns: 1fr;
    }
  }
</style>
