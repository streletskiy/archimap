<script>
  import { tick } from 'svelte';

  import { UiButton, UiScrollArea } from '$lib/components/base';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';

  import EditLocationMap from './EditLocationMap.svelte';

  export let open = false;
  export let title = '';
  export let closeLabel = '';
  export let closeDisabled = false;
  export let selectedFeature = null;
  export let mapLoading = false;
  export let mapLoadingText = '';
  export let onClose = () => {};

  let modalEl = null;
  let hadOpenState = false;

  function closeModal() {
    if (closeDisabled) return;
    onClose?.();
  }

  function onModalKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
    }
  }

  $: if (open && !hadOpenState) {
    hadOpenState = true;
    tick().then(() => modalEl?.focus());
  } else if (!open && hadOpenState) {
    hadOpenState = false;
  }
  $: void hadOpenState;
</script>

{#if open}
  <div class="edit-detail-backdrop">
    <button
      type="button"
      class="edit-detail-dismiss-layer"
      tabindex="-1"
      aria-label={closeLabel}
      disabled={closeDisabled}
      on:click={closeModal}
    ></button>

    <div
      class="edit-detail-modal"
      bind:this={modalEl}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      on:keydown={onModalKeydown}
    >
      <div class="edit-detail-map-shell">
        <EditLocationMap
          {selectedFeature}
          loading={mapLoading}
          loadingText={mapLoadingText}
        />

        <div class="edit-detail-map-bar">
          <h2>{title}</h2>
          <UiButton
            type="button"
            variant="secondary"
            size="close"
            className="shrink-0"
            aria-label={closeLabel}
            disabled={closeDisabled}
            onclick={closeModal}
          >
            <CloseIcon class="ui-close-icon" />
          </UiButton>
        </div>
      </div>

      <div class="edit-detail-body">
        <UiScrollArea className="ui-scroll-surface h-full">
          <div class="edit-detail-body-content">
            <slot />
          </div>
        </UiScrollArea>
      </div>
    </div>
  </div>
{/if}

<style>
  .edit-detail-backdrop {
    --edit-detail-gap: 0.85rem;
    --edit-detail-top-gap: calc(var(--edit-detail-gap) + env(safe-area-inset-top, 0px));
    --edit-detail-bottom-gap: calc(var(--edit-detail-gap) + env(safe-area-inset-bottom, 0px));
    position: fixed;
    inset: 0;
    z-index: 1310;
    display: grid;
    place-items: center;
    padding: var(--edit-detail-top-gap) var(--edit-detail-gap) var(--edit-detail-bottom-gap);
    background: rgba(8, 17, 31, 0.66);
    overscroll-behavior: contain;
  }

  .edit-detail-dismiss-layer {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: transparent;
  }

  .edit-detail-modal {
    position: relative;
    z-index: 1;
    width: min(72rem, calc(100vw - (var(--edit-detail-gap) * 2)));
    height: min(48rem, calc(100vh - var(--edit-detail-top-gap) - var(--edit-detail-bottom-gap)));
    height: min(48rem, calc(100dvh - var(--edit-detail-top-gap) - var(--edit-detail-bottom-gap)));
    max-height: calc(100vh - var(--edit-detail-top-gap) - var(--edit-detail-bottom-gap));
    max-height: calc(100dvh - var(--edit-detail-top-gap) - var(--edit-detail-bottom-gap));
    min-height: 0;
    overflow: hidden;
    display: grid;
    grid-template-rows: clamp(12rem, 30vh, 16rem) minmax(0, 1fr);
    gap: 0.9rem;
    padding: 0.95rem;
    border: 1px solid var(--panel-border);
    border-radius: 1.45rem;
    background: var(--panel-solid);
    box-shadow: var(--shadow-panel);
  }

  .edit-detail-map-shell {
    position: relative;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--panel-border);
    border-radius: 1.15rem;
    background: var(--bg-muted);
  }

  .edit-detail-map-bar {
    position: absolute;
    inset: 0 0 auto 0;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.9rem;
    pointer-events: none;
  }

  .edit-detail-map-bar :global(button) {
    pointer-events: auto;
  }

  .edit-detail-map-bar h2 {
    margin: 0;
    max-width: min(100%, 38rem);
    display: inline-flex;
    align-items: center;
    padding: 0.55rem 0.75rem;
    border: 1px solid var(--panel-border);
    border-radius: 0.95rem;
    background: var(--panel-solid);
    color: var(--fg-strong);
    font-size: 1.05rem;
    font-weight: 800;
    line-height: 1.25;
    box-shadow: var(--shadow-soft);
  }

  .edit-detail-body {
    min-height: 0;
    border: 1px solid var(--panel-border);
    border-radius: 1.15rem;
    background: var(--panel-solid);
  }

  .edit-detail-body :global([data-slot='scroll-area']),
  .edit-detail-body :global([data-slot='scroll-area-viewport']) {
    min-width: 0;
  }

  .edit-detail-body-content {
    display: grid;
    gap: 0.9rem;
    min-width: 0;
    padding: 0.8rem;
  }

  :global(.edit-detail-flow) {
    display: grid;
    gap: 0.9rem;
    min-width: 0;
  }

  :global(.edit-detail-flow > *) {
    min-width: 0;
  }

  :global(.edit-detail-meta) {
    min-width: 0;
  }

  :global(.edit-detail-meta > *) {
    min-width: 0;
  }

  :global(.edit-detail-meta-primary),
  :global(.edit-detail-break) {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  @media (max-width: 767px) {
    .edit-detail-backdrop {
      --edit-detail-gap: 0.65rem;
    }

    .edit-detail-modal {
      width: 100%;
      height: calc(100vh - var(--edit-detail-top-gap) - var(--edit-detail-bottom-gap));
      height: calc(100dvh - var(--edit-detail-top-gap) - var(--edit-detail-bottom-gap));
      max-height: calc(100vh - var(--edit-detail-top-gap) - var(--edit-detail-bottom-gap));
      max-height: calc(100dvh - var(--edit-detail-top-gap) - var(--edit-detail-bottom-gap));
      grid-template-rows: clamp(9.5rem, 24vh, 12rem) minmax(0, 1fr);
      padding: 0.75rem;
      border-radius: 1.2rem;
    }

    .edit-detail-map-bar {
      padding: 0.7rem;
    }

    .edit-detail-map-bar h2 {
      font-size: 0.96rem;
      max-width: calc(100% - 3.5rem);
      padding: 0.45rem 0.65rem;
    }

    .edit-detail-body-content {
      padding: 0.65rem;
    }

    :global(.edit-detail-flow) {
      gap: 0.75rem;
    }
  }
</style>
