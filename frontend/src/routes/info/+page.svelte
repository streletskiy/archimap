<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { parseUrlState, patchUrlState } from '$lib/client/urlState';
  import PortalFrame from '$lib/components/shell/PortalFrame.svelte';
  import { t } from '$lib/i18n/index';
  import { marked } from 'marked';
  import { APP_REPO_URL, APP_VERSION, APP_VERSION_DISPLAY } from '$lib/version';
  import agreementMarkdownSource from '../../../../legal/user-agreement.ru.md?raw';
  import privacyMarkdownSource from '../../../../legal/privacy-policy.ru.md?raw';

  let activeTab = 'about';
  let infoUrlSyncBusy = false;
  let agreementHtml = '';
  let privacyHtml = '';

  marked.setOptions({
    gfm: true,
    breaks: true
  });

  function markdownToHtml(markdown) {
    return marked.parse(String(markdown || ''));
  }
  agreementHtml = markdownToHtml(agreementMarkdownSource);
  privacyHtml = markdownToHtml(privacyMarkdownSource);

  function resolveActiveTabFromInfoState(info) {
    if (info?.tab === 'legal' && info?.doc === 'privacy') return 'privacy';
    if (info?.tab === 'legal') return 'agreement';
    return 'about';
  }

  function toInfoStateFromActiveTab(tab) {
    if (tab === 'privacy') return { tab: 'legal', doc: 'privacy' };
    if (tab === 'agreement') return { tab: 'legal', doc: 'terms' };
    return { tab: 'about', doc: null };
  }

  function setTab(nextTab) {
    if (activeTab === nextTab) return;
    activeTab = nextTab;
    replaceInfoUrlFromState(nextTab);
  }

  async function replaceInfoUrlFromState(tab) {
    if (typeof window === 'undefined') return;
    const current = new URL(window.location.href);
    const next = patchUrlState(current, { info: toInfoStateFromActiveTab(tab) });
    if (next.toString() === current.toString()) return;
    infoUrlSyncBusy = true;
    try {
      await goto(`${next.pathname}${next.search}${next.hash}`, {
        replaceState: true,
        keepFocus: true,
        noScroll: true
      });
    } finally {
      queueMicrotask(() => {
        infoUrlSyncBusy = false;
      });
    }
  }

  onMount(() => {
    const syncFromLocation = () => {
      if (infoUrlSyncBusy || typeof window === 'undefined') return;
      const state = parseUrlState(window.location.href);
      const nextTab = resolveActiveTabFromInfoState(state.info);
      if (nextTab !== activeTab) activeTab = nextTab;
    };
    syncFromLocation();
    window.addEventListener('popstate', syncFromLocation);

    return () => {
      window.removeEventListener('popstate', syncFromLocation);
    };
  });
</script>

<PortalFrame eyebrow="Archimap" title={$t('info.title')} description={$t('info.subtitle')}>
  <svelte:fragment slot="meta">
    <span class="ui-chip"><strong>{$t('info.version')}</strong>{APP_VERSION_DISPLAY}</span>
    <span class="ui-chip"><strong>{$t('info.commit')}</strong>{APP_VERSION.git.describe}</span>
    <a class="ui-btn ui-btn-secondary ui-btn-xs" href={APP_REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
  </svelte:fragment>

  <div>
    <ul class="ui-tab-shell flex flex-wrap gap-1" role="tablist">
      <li role="presentation"><button type="button" class="ui-tab-btn" class:ui-tab-btn-active={activeTab === 'about'} on:click={() => setTab('about')}>{$t('info.tabAbout')}</button></li>
      <li role="presentation"><button type="button" class="ui-tab-btn" class:ui-tab-btn-active={activeTab === 'agreement'} on:click={() => setTab('agreement')}>{$t('info.tabAgreement')}</button></li>
      <li role="presentation"><button type="button" class="ui-tab-btn" class:ui-tab-btn-active={activeTab === 'privacy'} on:click={() => setTab('privacy')}>{$t('info.tabPrivacy')}</button></li>
    </ul>
  </div>

  {#if activeTab === 'about'}
    <section class="mt-4">
      <div class="portal-notice about-copy">
        <h2>{$t('info.aboutTitle')}</h2>
        <p>{$t('info.aboutText')}</p>
        <p>{$t('info.aboutTextExtended')}</p>

        <div class="about-features">
          <p class="ui-kicker">{$t('info.aboutFeaturesTitle')}</p>
          <ul class="about-list">
            <li>{$t('info.aboutFeatureMap')}</li>
            <li>{$t('info.aboutFeatureEdits')}</li>
            <li>{$t('info.aboutFeatureAdmin')}</li>
          </ul>
        </div>
      </div>
    </section>
  {:else if activeTab === 'agreement'}
    <section class="legal-shell mt-4">
      <div class="legal-markdown text-sm leading-7 text-slate-700">{@html agreementHtml}</div>
    </section>
  {:else}
    <section class="legal-shell mt-4">
      <div class="legal-markdown text-sm leading-7 text-slate-700">{@html privacyHtml}</div>
    </section>
  {/if}
</PortalFrame>

<style>
  .about-copy {
    display: grid;
    gap: 0.9rem;
  }

  .about-copy h2 {
    margin: 0;
    color: var(--fg-strong);
    font-size: 1.125rem;
    font-weight: 800;
  }

  .about-copy p {
    margin: 0;
    color: var(--muted-strong);
    font-size: 0.98rem;
    line-height: 1.75;
    max-width: 78rem;
  }

  .about-features {
    display: grid;
    gap: 0.55rem;
    padding-top: 0.35rem;
  }

  .about-list {
    margin: 0;
    padding-left: 1.2rem;
    color: var(--muted-strong);
    display: grid;
    gap: 0.45rem;
    line-height: 1.65;
  }

  .legal-shell {
    padding: 1.2rem 1.25rem;
    border: 1px solid var(--panel-border);
    border-radius: 1.35rem;
    background: color-mix(in srgb, var(--panel-solid) 84%, transparent);
    box-shadow: 0 14px 30px rgba(15, 23, 42, 0.06);
  }

  .legal-markdown :global(h1),
  .legal-markdown :global(h2),
  .legal-markdown :global(h3),
  .legal-markdown :global(h4) {
    margin: 1rem 0 0.55rem;
    color: var(--fg-strong);
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
    color: var(--accent-ink);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .legal-markdown :global(blockquote) {
    margin: 0.7rem 0;
    padding: 0.55rem 0.7rem;
    border-left: 3px solid var(--panel-border-strong);
    background: color-mix(in srgb, var(--panel-solid) 80%, transparent);
    border-radius: 0.45rem;
  }

  .legal-markdown :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    background: color-mix(in srgb, var(--panel-solid) 76%, transparent);
    padding: 0.08rem 0.3rem;
    border-radius: 0.35rem;
  }

  .legal-markdown :global(pre) {
    background: color-mix(in srgb, var(--panel-solid) 80%, transparent);
    border: 1px solid var(--panel-border);
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
    border: 1px solid var(--panel-border);
    padding: 0.45rem 0.55rem;
    text-align: left;
    vertical-align: top;
  }

  .legal-markdown :global(hr) {
    border: 0;
    border-top: 1px solid var(--panel-border);
    margin: 0.85rem 0;
  }

  :global(html[data-theme='dark']) .legal-markdown :global(h1),
  :global(html[data-theme='dark']) .legal-markdown :global(h2),
  :global(html[data-theme='dark']) .legal-markdown :global(h3),
  :global(html[data-theme='dark']) .legal-markdown :global(h4) {
    color: var(--fg-strong);
  }

  :global(html[data-theme='dark']) .legal-markdown :global(a) {
    color: var(--accent-ink);
  }

  :global(html[data-theme='dark']) .legal-markdown :global(blockquote) {
    border-left-color: var(--panel-border-strong);
    background: color-mix(in srgb, var(--panel-solid) 76%, transparent);
    color: var(--fg);
  }

  :global(html[data-theme='dark']) .legal-markdown :global(code) {
    background: color-mix(in srgb, var(--panel-solid) 74%, transparent);
    color: var(--fg-strong);
  }

  :global(html[data-theme='dark']) .legal-markdown :global(pre) {
    background: color-mix(in srgb, var(--panel-solid) 74%, transparent);
    border-color: var(--panel-border);
    color: var(--fg-strong);
  }

  :global(html[data-theme='dark']) .legal-markdown :global(th),
  :global(html[data-theme='dark']) .legal-markdown :global(td) {
    border-color: var(--panel-border);
    color: var(--fg);
  }

  :global(html[data-theme='dark']) .legal-markdown :global(hr) {
    border-top-color: var(--panel-border);
  }
</style>
