<script>
  export let filterStatusCode = 'idle';
  export let filterStatusOverlayText = '';
  export let filterErrorMessage = '';
  export let styleTransitionOverlaySrc = null;
  export let styleTransitionOverlayVisible = false;
</script>

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
</style>
