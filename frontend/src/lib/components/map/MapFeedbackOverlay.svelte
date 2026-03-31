<script>
  import { Loader2 } from '@lucide/svelte';
  import { UiCard } from '$lib/components/base';

  export let filterStatusCode = 'idle';
  export let filterStatusOverlayText = '';
  export let filterErrorMessage = '';
  export let filterApplyVisible = false;
  export let filterApplyLabel = '';
  export let filterApplyProgress = 0;
  export let styleTransitionOverlaySrc = null;
  export let styleTransitionOverlayVisible = false;

  $: normalizedFilterApplyProgress = Math.max(0, Math.min(100, Math.round(Number(filterApplyProgress) || 0)));
</script>

{#if filterApplyVisible}
  <div class="map-filter-apply-overlay" role="status" aria-live="polite" aria-busy="true">
    <UiCard padded className="map-filter-apply-card">
      <div class="map-filter-apply-spinner" aria-hidden="true">
        <Loader2 size={30} strokeWidth={2.25} />
      </div>
      <div class="map-filter-apply-copy">
        <div class="map-filter-apply-title">{filterApplyLabel}</div>
        <div
          class="map-filter-apply-progress-track"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={normalizedFilterApplyProgress}
        >
          <div
            class="map-filter-apply-progress-fill"
            style={`width: ${normalizedFilterApplyProgress}%`}
          ></div>
        </div>
        <div class="map-filter-apply-progress-text">{normalizedFilterApplyProgress}%</div>
      </div>
    </UiCard>
  </div>
{/if}

{#if filterStatusOverlayText}
  <div class="map-filter-status" data-filter-status-code={filterStatusCode} role="status" aria-live="polite">
    {filterStatusOverlayText}
  </div>
{/if}

{#if filterErrorMessage}
  <div class="map-filter-error" role="status" aria-live="polite">{filterErrorMessage}</div>
{/if}

{#if styleTransitionOverlaySrc}
  <img
    class:visible={styleTransitionOverlayVisible}
    class="map-style-transition-overlay"
    src={styleTransitionOverlaySrc}
    alt=""
    aria-hidden="true"
  />
{/if}

<style>
  .map-style-transition-overlay {
    position: fixed;
    inset: 0;
    z-index: 9;
    width: 100%;
    height: 100%;
    object-fit: cover;
    pointer-events: none;
    opacity: 0;
    transition: opacity 260ms ease;
  }

  .map-style-transition-overlay.visible {
    opacity: 1;
  }

  .map-filter-apply-overlay {
    position: fixed;
    inset: 0;
    z-index: 11;
    display: grid;
    place-items: center;
    pointer-events: none;
    padding: 1rem;
  }

  :global(.map-filter-apply-card) {
    width: min(22rem, calc(100vw - 2rem));
    border: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
    background: color-mix(in srgb, var(--color-card) 88%, transparent);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.32);
    backdrop-filter: blur(14px);
  }

  .map-filter-apply-spinner {
    display: grid;
    place-items: center;
    width: 3rem;
    height: 3rem;
    margin-inline: auto;
    margin-bottom: 0.85rem;
    border-radius: 999px;
    color: var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  }

  .map-filter-apply-spinner :global(svg) {
    animation: map-filter-spin 1s linear infinite;
  }

  .map-filter-apply-copy {
    display: grid;
    gap: 0.55rem;
    text-align: center;
  }

  .map-filter-apply-title {
    color: var(--color-card-foreground);
    font-size: 0.95rem;
    font-weight: 600;
    line-height: 1.25;
  }

  .map-filter-apply-progress-track {
    width: 100%;
    height: 0.45rem;
    overflow: hidden;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-muted) 82%, transparent);
  }

  .map-filter-apply-progress-fill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 65%, white));
    transition: width 180ms ease;
  }

  .map-filter-apply-progress-text {
    color: var(--color-muted-foreground);
    font-size: 0.78rem;
    line-height: 1.2;
    letter-spacing: 0.04em;
  }

  .map-filter-error {
    position: fixed;
    left: 0.75rem;
    bottom: 3.9rem;
    z-index: 10;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(185, 28, 28, 0.9);
    color: #ffffff;
    font-size: 12px;
    line-height: 1.3;
    max-width: min(78vw, 440px);
    pointer-events: none;
  }

  @keyframes map-filter-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
