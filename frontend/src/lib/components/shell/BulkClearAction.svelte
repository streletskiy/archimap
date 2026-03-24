<script>
  import { UiButton } from '$lib/components/base';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import { cn } from '$lib/utils/ui.js';

  export let show = false;
  export let ariaLabel = '';
  export let title = '';
  export let className = '';
  export let onclick = undefined;
</script>

<div class={cn('bulk-clear-shell', show && 'bulk-clear-shell--shown', className)}>
  <slot />

  {#if show}
    <UiButton
      type="button"
      variant="ghost"
      size="square-sm"
      className="bulk-clear-shell-button"
      aria-label={ariaLabel}
      title={title || ariaLabel}
      onclick={onclick}
    >
      <CloseIcon class="bulk-clear-shell-icon" />
    </UiButton>
  {/if}
</div>

<style>
  .bulk-clear-shell {
    position: relative;
  }

  :global(.bulk-clear-shell--shown > .ui-input),
  :global(.bulk-clear-shell--shown > .ui-textarea),
  :global(.bulk-clear-shell--shown > .ui-select-trigger),
  :global(.bulk-clear-shell--shown > .ui-date-trigger),
  :global(.bulk-clear-shell--shown > .ui-color-picker),
  :global(.bulk-clear-shell--shown > .colour-picker-row) {
    padding-right: 2.25rem;
  }

  :global(.bulk-clear-shell-button) {
    position: absolute;
    top: 50%;
    right: 0.5rem;
    transform: translateY(-50%);
    z-index: 1;
    width: 1.75rem;
    min-width: 1.75rem;
    min-height: 1.75rem;
    padding: 0;
    border-radius: 0.375rem;
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
    box-shadow: 0 6px 18px rgba(15, 23, 42, 0.08);
  }

  :global(.bulk-clear-shell-button:hover) {
    background: var(--panel-solid);
  }

  :global(.bulk-clear-shell-icon) {
    width: 0.78rem;
    height: 0.78rem;
  }
</style>
