<script>
  import { onMount } from 'svelte';
  import { marked } from 'marked';
  import { apiJson } from '$lib/services/http';

  let activeTab = 'about';
  let agreementLoading = true;
  let privacyLoading = true;
  let agreementTitle = 'Пользовательское соглашение';
  let privacyTitle = 'Политика конфиденциальности';
  let agreementText = '';
  let privacyText = '';
  let agreementError = '';
  let privacyError = '';
  let agreementHtml = '';
  let privacyHtml = '';

  marked.setOptions({
    gfm: true,
    breaks: true
  });

  function markdownToHtml(markdown) {
    return marked.parse(String(markdown || ''));
  }

  async function loadLegalDoc(slug) {
    return apiJson(`/api/legal-docs/${slug}`);
  }

  async function loadAgreement() {
    agreementLoading = true;
    agreementError = '';
    try {
      const payload = await loadLegalDoc('user-agreement');
      agreementTitle = String(payload?.title || 'Пользовательское соглашение');
      agreementText = String(payload?.markdown || '');
      agreementHtml = markdownToHtml(agreementText);
    } catch (error) {
      agreementError = String(error?.message || 'Не удалось загрузить пользовательское соглашение');
      agreementText = '';
      agreementHtml = '';
    } finally {
      agreementLoading = false;
    }
  }

  async function loadPrivacy() {
    privacyLoading = true;
    privacyError = '';
    try {
      const payload = await loadLegalDoc('privacy-policy');
      privacyTitle = String(payload?.title || 'Политика конфиденциальности');
      privacyText = String(payload?.markdown || '');
      privacyHtml = markdownToHtml(privacyText);
    } catch (error) {
      privacyError = String(error?.message || 'Не удалось загрузить политику конфиденциальности');
      privacyText = '';
      privacyHtml = '';
    } finally {
      privacyLoading = false;
    }
  }

  onMount(() => {
    loadAgreement();
    loadPrivacy();
  });
</script>

<main class="w-full px-3 pb-5 pt-[5.5rem] sm:px-4 sm:pb-6 sm:pt-[5.25rem]">
  <section class="rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-soft backdrop-blur-sm sm:p-5">
    <div class="border-b border-slate-200 pb-4">
      <h1 class="text-2xl font-extrabold text-slate-900">Информация</h1>
      <p class="mt-1 text-sm text-slate-600">О сервисе, техническая информация и юридические документы.</p>
    </div>

    <div class="mt-4">
      <ul class="ui-tab-shell flex flex-wrap gap-1" role="tablist">
        <li role="presentation"><button type="button" class="ui-tab-btn" class:ui-tab-btn-active={activeTab === 'about'} on:click={() => (activeTab = 'about')}>О сервисе</button></li>
        <li role="presentation"><button type="button" class="ui-tab-btn" class:ui-tab-btn-active={activeTab === 'agreement'} on:click={() => (activeTab = 'agreement')}>Пользовательское соглашение</button></li>
        <li role="presentation"><button type="button" class="ui-tab-btn" class:ui-tab-btn-active={activeTab === 'privacy'} on:click={() => (activeTab = 'privacy')}>Политика конфиденциальности</button></li>
      </ul>
    </div>

    {#if activeTab === 'about'}
      <section class="mt-4 space-y-4">
        <div class="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 class="text-lg font-bold text-slate-900">О сервисе</h2>
          <p class="mt-2 text-sm leading-7 text-slate-700">archimap помогает собирать и модератировать архитектурные данные зданий на карте.</p>
        </div>

        <div class="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 class="text-lg font-bold text-slate-900">Техническая информация</h2>
          <div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-700">
            <div class="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1"><span class="font-semibold uppercase tracking-wide text-slate-500">Версия</span><span class="font-semibold text-slate-900">-</span></div>
            <div class="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1"><span class="font-semibold uppercase tracking-wide text-slate-500">Коммит</span><span class="font-semibold text-slate-900">-</span></div>
          </div>
        </div>
      </section>
    {:else if activeTab === 'agreement'}
      <section class="mt-4 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 class="text-lg font-bold text-slate-900">{agreementTitle}</h2>
        {#if agreementLoading}
          <p class="mt-3 text-sm leading-7 text-slate-700">Загрузка документа...</p>
        {:else if agreementError}
          <p class="mt-3 text-sm leading-7 text-rose-600">{agreementError}</p>
        {:else}
          <div class="legal-markdown mt-3 text-sm leading-7 text-slate-700">{@html agreementHtml}</div>
        {/if}
      </section>
    {:else}
      <section class="mt-4 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 class="text-lg font-bold text-slate-900">{privacyTitle}</h2>
        {#if privacyLoading}
          <p class="mt-3 text-sm leading-7 text-slate-700">Загрузка документа...</p>
        {:else if privacyError}
          <p class="mt-3 text-sm leading-7 text-rose-600">{privacyError}</p>
        {:else}
          <div class="legal-markdown mt-3 text-sm leading-7 text-slate-700">{@html privacyHtml}</div>
        {/if}
      </section>
    {/if}
  </section>
</main>

<style>
  .legal-markdown :global(h1),
  .legal-markdown :global(h2),
  .legal-markdown :global(h3),
  .legal-markdown :global(h4) {
    margin: 1rem 0 0.55rem;
    color: #0f172a;
    line-height: 1.3;
  }

  .legal-markdown :global(h1) {
    font-size: 1.3rem;
    font-weight: 800;
  }

  .legal-markdown :global(h2) {
    font-size: 1.1rem;
    font-weight: 750;
  }

  .legal-markdown :global(h3),
  .legal-markdown :global(h4) {
    font-size: 1rem;
    font-weight: 700;
  }

  .legal-markdown :global(p) {
    margin: 0.6rem 0;
  }

  .legal-markdown :global(ul),
  .legal-markdown :global(ol) {
    margin: 0.65rem 0;
    padding-left: 1.2rem;
  }

  .legal-markdown :global(li) {
    margin: 0.25rem 0;
  }

  .legal-markdown :global(a) {
    color: #3349d9;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .legal-markdown :global(blockquote) {
    margin: 0.7rem 0;
    padding: 0.55rem 0.7rem;
    border-left: 3px solid #cbd5e1;
    background: #f8fafc;
    border-radius: 0.45rem;
  }

  .legal-markdown :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    background: #f1f5f9;
    padding: 0.08rem 0.3rem;
    border-radius: 0.35rem;
  }

  .legal-markdown :global(pre) {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 0.7rem;
    padding: 0.7rem;
    overflow: auto;
  }

  .legal-markdown :global(pre code) {
    background: transparent;
    padding: 0;
  }

  .legal-markdown :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 0.7rem 0;
  }

  .legal-markdown :global(th),
  .legal-markdown :global(td) {
    border: 1px solid #e2e8f0;
    padding: 0.45rem 0.55rem;
    text-align: left;
    vertical-align: top;
  }

  .legal-markdown :global(hr) {
    border: 0;
    border-top: 1px solid #e2e8f0;
    margin: 0.85rem 0;
  }

  :global(html[data-theme='dark']) .legal-markdown :global(h1),
  :global(html[data-theme='dark']) .legal-markdown :global(h2),
  :global(html[data-theme='dark']) .legal-markdown :global(h3),
  :global(html[data-theme='dark']) .legal-markdown :global(h4) {
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .legal-markdown :global(a) {
    color: #a5b4fc;
  }

  :global(html[data-theme='dark']) .legal-markdown :global(blockquote) {
    border-left-color: #475569;
    background: #0f172a;
    color: #cbd5e1;
  }

  :global(html[data-theme='dark']) .legal-markdown :global(code) {
    background: #0f172a;
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .legal-markdown :global(pre) {
    background: #0f172a;
    border-color: #334155;
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .legal-markdown :global(th),
  :global(html[data-theme='dark']) .legal-markdown :global(td) {
    border-color: #334155;
    color: #cbd5e1;
  }

  :global(html[data-theme='dark']) .legal-markdown :global(hr) {
    border-top-color: #334155;
  }
</style>
