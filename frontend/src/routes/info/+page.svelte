<script>
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { buildInfoUrl, resolveInfoTabFromUrl } from '$lib/client/section-routes';
  import { UiBadge, UiTabsNav } from '$lib/components/base';
  import PortalFrame from '$lib/components/shell/PortalFrame.svelte';
  import { t } from '$lib/i18n/index';
  import { marked } from 'marked';
  import { APP_REPO_URL, APP_VERSION_DISPLAY } from '$lib/version';
  import agreementMarkdownSource from '../../../../legal/user-agreement.ru.md?raw';
  import privacyMarkdownSource from '../../../../legal/privacy-policy.ru.md?raw';

  let activeTab = resolveInfoTabFromUrl(get(page).url);
  let infoUrlSyncBusy = false;
  let agreementHtml;
  let privacyHtml;
  let lastHandledTab;
  let infoTabInitialized = false;
  $: infoTabs = [
    { value: 'about', label: $t('info.tabAbout') },
    { value: 'agreement', label: $t('info.tabAgreement') },
    { value: 'privacy', label: $t('info.tabPrivacy') }
  ];

  marked.setOptions({
    gfm: true,
    breaks: true
  });

  function markdownToHtml(markdown) {
    return marked.parse(String(markdown || ''));
  }
  agreementHtml = markdownToHtml(agreementMarkdownSource);
  privacyHtml = markdownToHtml(privacyMarkdownSource);
  $: if (!infoTabInitialized) {
    infoTabInitialized = true;
    lastHandledTab = activeTab;
  } else if (activeTab !== lastHandledTab) {
    lastHandledTab = activeTab;
    void replaceInfoUrl(activeTab);
  }
  $: void infoTabInitialized;
  $: void lastHandledTab;

  async function replaceInfoUrl(tab) {
    if (typeof window === 'undefined') return;
    const next = buildInfoUrl(window.location.href, tab);
    const current = new URL(window.location.href);
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
    const syncFromPage = async ($pageState) => {
      if (infoUrlSyncBusy) return;
      const nextTab = resolveInfoTabFromUrl($pageState.url);
      if (nextTab !== activeTab) activeTab = nextTab;
      await replaceInfoUrl(nextTab);
    };
    const unsubscribePage = page.subscribe(($pageState) => {
      void syncFromPage($pageState);
    });

    return () => {
      unsubscribePage();
    };
  });
</script>

<PortalFrame title={$t('info.title')} description={$t('info.subtitle')}>
  <svelte:fragment slot="meta">
    <UiBadge
      variant="accent"
      className="max-w-full flex-col items-start justify-start whitespace-normal break-words text-left gap-0.5 sm:flex-row sm:items-center sm:gap-1"
    >
      <strong>{$t('info.version')}:</strong>
      <span class="min-w-0 whitespace-normal break-words">{APP_VERSION_DISPLAY}</span>
    </UiBadge>
    <UiBadge
      variant="outline"
      href={APP_REPO_URL}
      className="max-w-full whitespace-normal break-words"
      target="_blank"
      rel="noopener noreferrer"
    >
      {APP_REPO_URL}
    </UiBadge>
  </svelte:fragment>

  <UiTabsNav bind:value={activeTab} items={infoTabs} />

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
      <div class="legal-markdown text-sm leading-7 ui-text-body">{@html agreementHtml}</div>
    </section>
  {:else}
    <section class="legal-shell mt-4">
      <div class="legal-markdown text-sm leading-7 ui-text-body">{@html privacyHtml}</div>
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

  .legal-markdown {
    min-width: 0;
    overflow-wrap: anywhere;
    word-break: break-word;
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
    overflow-wrap: anywhere;
    word-break: break-word;
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

  @media (max-width: 768px) {
    .legal-shell {
      padding: 1rem 0.95rem;
    }
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
