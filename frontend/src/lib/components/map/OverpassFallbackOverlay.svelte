<script>
  import { locale, t } from '$lib/i18n/index';
  import { UiButton, UiCard } from '$lib/components/base';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import RefreshIcon from '$lib/components/icons/RefreshIcon.svelte';
  import TrashIcon from '$lib/components/icons/TrashIcon.svelte';
  import { resolveUiLocaleTag } from '$lib/utils/edit-ui.js';
  import { quintOut } from 'svelte/easing';
  import { fade, scale } from 'svelte/transition';

  export let visible = false;
  export let loading = false;
  export let canLoad = false;
  export let hasCachedData = false;
  export let messageKey = 'idle';
  export let message = '';
  export let error = '';
  export let progressDone = 0;
  export let progressTotal = 0;
  export let lastSyncedAt = 0;
  export let onLoad = () => {};
  export let onRefresh = () => {};
  export let onClearCache = () => {};
  let collapsed = false;

  $: normalizedDone = Math.max(0, Math.trunc(Number(progressDone) || 0));
  $: normalizedTotal = Math.max(0, Math.trunc(Number(progressTotal) || 0));
  $: normalizedProgress = normalizedTotal > 0
    ? Math.max(0, Math.min(100, Math.round((normalizedDone / normalizedTotal) * 100)))
    : 0;
  $: normalizedLastSyncedAt = Math.max(0, Math.trunc(Number(lastSyncedAt) || 0));
  $: messageText = String(message || '').trim();
  $: title = $t('mapPage.overpassFallback.title');
  $: body = $t('mapPage.overpassFallback.description');
  $: loadButtonLabel = $t('mapPage.overpassFallback.loadAction');
  $: refreshButtonLabel = $t('mapPage.overpassFallback.refreshAction');
  $: clearCacheButtonLabel = $t('mapPage.overpassFallback.clearCache');
  $: lastSyncLabel = $t('mapPage.overpassFallback.lastSync');
  $: zoomHintLabel = $t('mapPage.overpassFallback.zoomIn');
  $: cacheReadyLabel = $t('mapPage.overpassFallback.cacheReady');
  $: collapseButtonLabel = $t('mapPage.overpassFallback.collapse');
  $: expandButtonLabel = $t('mapPage.overpassFallback.expand');
  $: isZoomTooLow = Boolean(!loading && !error && messageKey === 'zoomIn');
  $: isCacheReady = Boolean(!loading && !error && messageKey === 'cacheReady');
  $: zoomHint = isZoomTooLow ? zoomHintLabel : (isCacheReady ? cacheReadyLabel : messageText || cacheReadyLabel);
  $: showZoomHint = Boolean(!loading && !error && (isZoomTooLow || isCacheReady));
  $: showLoadAction = Boolean(!loading && !error && canLoad);
  $: showRefreshAction = Boolean(hasCachedData && !loading && !error && (isCacheReady || canLoad));
  $: showClearCacheAction = Boolean(hasCachedData && !loading);
  $: hasLastSyncInfo = normalizedLastSyncedAt > 0;
  $: showHeaderSyncMeta = Boolean(showLoadAction && hasLastSyncInfo);
  $: showActionSyncMeta = Boolean(!showLoadAction && hasLastSyncInfo);
  $: if (!visible) {
    collapsed = false;
  }
  $: actionsLayoutClass = showLoadAction || showActionSyncMeta
    ? 'overpass-fallback-actions--split'
    : 'overpass-fallback-actions--icons';
  $: lastSyncedLabel = normalizedLastSyncedAt > 0
    ? new Intl.DateTimeFormat(resolveUiLocaleTag($locale), {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(new Date(normalizedLastSyncedAt))
    : '';
  $: showOverlay = Boolean(visible);

  function handleLoad(event) {
    event.preventDefault();
    onLoad?.();
  }

  function handleRefresh(event) {
    event.preventDefault();
    onRefresh?.();
  }

  function handleClearCache(event) {
    event.preventDefault();
    onClearCache?.();
  }

  function handleCollapse(event) {
    event.preventDefault();
    collapsed = true;
  }

  function handleExpand(event) {
    event.preventDefault();
    collapsed = false;
  }
</script>

{#if showOverlay}
  <div
    class={`overpass-fallback-overlay ${collapsed ? 'overpass-fallback-overlay--collapsed' : ''}`}
    role="dialog"
    aria-label={collapsed ? title : undefined}
    aria-labelledby={collapsed ? undefined : 'overpass-fallback-title'}
    aria-live="polite"
    aria-busy={loading ? 'true' : 'false'}
    transition:fade={{ duration: 120 }}
  >
    {#if collapsed}
      <div class="overpass-fallback-expand-shell" transition:scale={{ start: 0.9, duration: 140, easing: quintOut }}>
        <UiButton
          type="button"
          variant="secondary"
          size="square-sm"
          className="overpass-fallback-expand-button"
          aria-label={expandButtonLabel}
          title={expandButtonLabel}
          onclick={handleExpand}
        >
          <RefreshIcon size={16} />
        </UiButton>
      </div>
    {:else}
      <div class="overpass-fallback-card-shell" transition:scale={{ start: 0.96, duration: 180, easing: quintOut }}>
        <UiCard padded className="overpass-fallback-card">
          <div class="overpass-fallback-header">
            <div class="overpass-fallback-titlewrap">
              <div class="overpass-fallback-title" id="overpass-fallback-title">{title}</div>
              <p class="overpass-fallback-body">{body}</p>
              {#if showZoomHint}
                <p class="overpass-fallback-note">{zoomHint}</p>
              {/if}
              {#if showHeaderSyncMeta}
                <p class="overpass-fallback-meta">
                  <span class="overpass-fallback-meta-label">{lastSyncLabel}</span>
                  <span class="overpass-fallback-meta-value">{lastSyncedLabel}</span>
                </p>
              {/if}
            </div>
          <UiButton
            type="button"
            variant="secondary"
            size="close"
            className="shrink-0"
            aria-label={collapseButtonLabel}
            title={collapseButtonLabel}
            onclick={handleCollapse}
          >
            <CloseIcon class="ui-close-icon" />
          </UiButton>
          </div>

          <div class="overpass-fallback-copy">
            {#if loading && normalizedTotal > 0}
              <div
                class="overpass-fallback-progress-track"
                role="progressbar"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={normalizedProgress}
              >
                <div
                  class="overpass-fallback-progress-fill"
                  style={`width: ${normalizedProgress}%`}
                ></div>
              </div>
            {/if}
          </div>

          <div class={`overpass-fallback-actions ${actionsLayoutClass}`}>
            {#if error}
              <UiButton
                type="button"
                variant="primary"
                className="overpass-fallback-load-button"
                onclick={handleLoad}
              >
                {$t('mapPage.overpassFallback.retry')}
              </UiButton>
              {#if showClearCacheAction}
                <UiButton
                  type="button"
                  variant="danger"
                  size="square-sm"
                  className="overpass-fallback-icon-button"
                  aria-label={clearCacheButtonLabel}
                  title={clearCacheButtonLabel}
                  onclick={handleClearCache}
                >
                  <TrashIcon size={16} />
                </UiButton>
              {/if}
            {:else if !loading}
              {#if showLoadAction}
                <UiButton
                  type="button"
                  variant="primary"
                  className="overpass-fallback-load-button"
                  onclick={handleLoad}
                >
                  {loadButtonLabel}
                </UiButton>
              {:else if showActionSyncMeta}
                <p class="overpass-fallback-meta">
                  <span class="overpass-fallback-meta-label">{lastSyncLabel}</span>
                  <span class="overpass-fallback-meta-value">{lastSyncedLabel}</span>
                </p>
              {/if}
              {#if showRefreshAction}
                <UiButton
                  type="button"
                  variant="secondary"
                  size="square-sm"
                  className="overpass-fallback-icon-button"
                  aria-label={refreshButtonLabel}
                  title={refreshButtonLabel}
                  onclick={handleRefresh}
                >
                  <RefreshIcon size={16} />
                </UiButton>
              {/if}
              {#if showClearCacheAction}
                <UiButton
                  type="button"
                  variant="danger"
                  size="square-sm"
                  className="overpass-fallback-icon-button"
                  aria-label={clearCacheButtonLabel}
                  title={clearCacheButtonLabel}
                  onclick={handleClearCache}
                >
                  <TrashIcon size={16} />
                </UiButton>
              {/if}
            {/if}
          </div>
        </UiCard>
      </div>
    {/if}
  </div>
{/if}

<style>
  .overpass-fallback-overlay {
    position: fixed;
    left: 0.75rem;
    bottom: 0.75rem;
    z-index: 12;
    width: min(24rem, calc(100vw - 1.5rem));
    pointer-events: none;
  }

  .overpass-fallback-overlay--collapsed {
    width: fit-content;
    display: inline-flex;
    align-items: flex-end;
  }

  :global(.overpass-fallback-card) {
    position: relative;
    display: grid;
    gap: 0.9rem;
    pointer-events: auto;
    transform-origin: left bottom;
    border: 1px solid color-mix(in srgb, var(--color-border) 72%, transparent);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--color-card) 95%, white) 0%, color-mix(in srgb, var(--color-card) 88%, transparent) 100%);
    box-shadow: 0 24px 60px rgba(6, 12, 24, 0.28);
    backdrop-filter: blur(16px);
    overflow: hidden;
  }

  .overpass-fallback-card-shell {
    display: inline-flex;
    width: min(24rem, calc(100vw - 1.5rem));
    pointer-events: auto;
    transform-origin: left bottom;
  }

  .overpass-fallback-header,
  .overpass-fallback-copy,
  .overpass-fallback-actions {
    position: relative;
    z-index: 1;
  }

  .overpass-fallback-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .overpass-fallback-titlewrap {
    display: grid;
    gap: 0.4rem;
    min-width: 0;
  }

  .overpass-fallback-body {
    margin: 0;
    color: var(--color-muted-foreground);
    font-size: 0.88rem;
    line-height: 1.45;
  }

  .overpass-fallback-note,
  .overpass-fallback-meta {
    margin: 0;
    color: color-mix(in srgb, var(--color-muted-foreground) 82%, var(--color-card-foreground));
    font-size: 0.78rem;
    line-height: 1.35;
  }

  .overpass-fallback-meta {
    display: grid;
    gap: 0.18rem;
  }

  .overpass-fallback-meta-label {
    font-weight: 600;
  }

  .overpass-fallback-meta-value {
    word-break: break-word;
  }

  .overpass-fallback-copy {
    display: grid;
    gap: 0.45rem;
  }

  .overpass-fallback-title {
    color: var(--color-card-foreground);
    font-size: 1rem;
    font-weight: 700;
    line-height: 1.2;
  }

  .overpass-fallback-progress-track {
    width: 100%;
    height: 0.45rem;
    overflow: hidden;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-muted) 82%, transparent);
  }

  .overpass-fallback-progress-fill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 62%, white));
    transition: width 180ms ease;
  }

  .overpass-fallback-actions {
    display: grid;
    gap: 0.5rem;
    width: 100%;
    align-items: center;
  }

  .overpass-fallback-actions--split {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .overpass-fallback-actions--icons {
    grid-template-columns: auto auto;
    justify-content: end;
  }

  :global(.overpass-fallback-load-button) {
    width: 100%;
    min-width: 0;
  }

  :global(.overpass-fallback-icon-button) {
    width: 2.5rem;
    min-width: 2.5rem;
    height: 2.5rem;
    min-height: 2.5rem;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  :global(.overpass-fallback-icon-button svg) {
    width: 1rem;
    height: 1rem;
  }

  :global(.overpass-fallback-expand-button) {
    pointer-events: auto;
  }

  .overpass-fallback-expand-shell {
    display: inline-flex;
    width: fit-content;
    pointer-events: auto;
    transform-origin: left bottom;
  }
</style>
