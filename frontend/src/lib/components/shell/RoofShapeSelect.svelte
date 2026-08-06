<script>
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import * as Popover from '$lib/components/ui/popover';
  import { t } from '$lib/i18n/index';
  import { cn } from '$lib/utils/ui.js';
  import {
    ROOF_SHAPE_SELECT_OPTIONS,
    getRoofShapeOption,
    normalizeRoofShapeSelection,
    toHumanRoofShape
  } from '$lib/utils/roof-shape';

  export let value = '';
  export let label = '';
  export let disabled = false;
  export let placeholder = '';
  export let className = '';
  export let triggerClassName = '';
  export let contentClassName = '';
  export let onchange = undefined;

  const dispatch = createEventDispatcher();

  let open = false;
  let scrollContainer = null;
  let hasVerticalOverflow = false;
  let verticalScrollbarWidth = 0;
  let scrollMetricsObserver = null;

  $: labelText = label || $t('buildingModal.roofShape');
  $: placeholderText = placeholder || $t('buildingModal.notSpecified');
  $: normalizedValue = normalizeRoofShapeSelection(value);
  $: selectedOption = getRoofShapeOption(normalizedValue);
  $: displayLabel = normalizedValue ? toHumanRoofShape(normalizedValue, $t) : placeholderText;
  $: displayImage = selectedOption?.imageUrl || '';

  function emitChange(nextValue) {
    const detail = {
      value: nextValue,
      option: getRoofShapeOption(nextValue),
      item: getRoofShapeOption(nextValue)
    };
    onchange?.({ detail });
    dispatch('change', detail);
  }

  function selectRoofShape(nextValue = '') {
    const normalized = normalizeRoofShapeSelection(nextValue);
    if (normalized === normalizedValue) {
      open = false;
      return;
    }
    value = normalized;
    emitChange(normalized);
    open = false;
  }

  function handleTriggerKeydown(event) {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open = true;
    }
  }

  function disconnectScrollMetricsObserver() {
    scrollMetricsObserver?.disconnect?.();
    scrollMetricsObserver = null;
  }

  function updateScrollMetrics() {
    if (!scrollContainer) {
      hasVerticalOverflow = false;
      verticalScrollbarWidth = 0;
      return;
    }
    const nextHasVerticalOverflow = scrollContainer.scrollHeight > (scrollContainer.clientHeight + 1);
    const measuredScrollbarWidth = Math.max(0, Number(scrollContainer.offsetWidth || 0) - Number(scrollContainer.clientWidth || 0));
    hasVerticalOverflow = nextHasVerticalOverflow;
    verticalScrollbarWidth = nextHasVerticalOverflow ? measuredScrollbarWidth : 0;
  }

  function connectScrollMetricsObserver() {
    disconnectScrollMetricsObserver();
    if (typeof ResizeObserver === 'undefined' || !scrollContainer) return;
    scrollMetricsObserver = new ResizeObserver(() => {
      updateScrollMetrics();
    });
    scrollMetricsObserver.observe(scrollContainer);
  }

  $: if (open) {
    void tick().then(() => {
      updateScrollMetrics();
      connectScrollMetricsObserver();
    });
  } else {
    disconnectScrollMetricsObserver();
    hasVerticalOverflow = false;
    verticalScrollbarWidth = 0;
  }

  onDestroy(() => {
    disconnectScrollMetricsObserver();
  });
</script>

<div class={cn('roof-shape-select', className)} data-disabled={disabled ? 'true' : 'false'}>
  <Popover.Root bind:open>
    <Popover.Trigger
      disabled={disabled}
      aria-label={labelText}
      title={displayLabel || placeholderText || labelText}
      class={cn('roof-shape-select-trigger', triggerClassName)}
      onkeydown={handleTriggerKeydown}
    >
      <span class="roof-shape-select-trigger-copy">
        <span class="roof-shape-select-trigger-thumb" aria-hidden="true" data-empty={displayImage ? 'false' : 'true'}>
          {#if displayImage}
            <img src={displayImage} alt="" loading="lazy" />
          {:else}
            <span class="roof-shape-select-trigger-placeholder">—</span>
          {/if}
        </span>
        <span class="roof-shape-select-trigger-text">
          <span class="roof-shape-select-trigger-label">{displayLabel}</span>
        </span>
      </span>
    </Popover.Trigger>

    <Popover.Content
      sideOffset={8}
      align="start"
      class={cn('roof-shape-select-content ui-floating-panel', contentClassName)}
    >
      {#snippet child({ props, wrapperProps })}
        <div
          {...wrapperProps}
          class="roof-shape-select-floating-wrapper"
          style:--roof-shape-scrollbar-width="`${verticalScrollbarWidth}px`"
          style:max-width="'calc(100dvw - 1rem)'"
        >
          <div {...props}>
            <div
              bind:this={scrollContainer}
              class="roof-shape-select-scroll"
              data-has-vertical-overflow={hasVerticalOverflow ? 'true' : 'false'}
            >
              <div class="roof-shape-select-grid">
                <button
                  type="button"
                  data-selected={!normalizedValue ? 'true' : 'false'}
                  class="roof-shape-option-card roof-shape-option-card--empty"
                  aria-pressed={!normalizedValue}
                  aria-label={placeholderText}
                  title={placeholderText}
                  onclick={() => selectRoofShape('')}
                >
                  <span class="roof-shape-option-thumb roof-shape-option-thumb--empty" aria-hidden="true">—</span>
                </button>

                {#each ROOF_SHAPE_SELECT_OPTIONS as option (option.value)}
                  {@const optionLabel = toHumanRoofShape(option?.value, $t) || option?.label || String(option?.value || '')}
                  <button
                    type="button"
                    data-selected={normalizedValue === option.value ? 'true' : 'false'}
                    class="roof-shape-option-card"
                    aria-pressed={normalizedValue === option.value}
                    aria-label={optionLabel}
                    title={optionLabel}
                    onclick={() => selectRoofShape(option.value)}
                  >
                    <span class="roof-shape-option-thumb" aria-hidden="true" data-empty={option.imageUrl ? 'false' : 'true'}>
                      {#if option.imageUrl}
                        <img src={option.imageUrl} alt="" loading="lazy" />
                      {:else}
                        <span class="roof-shape-option-thumb-fallback">—</span>
                      {/if}
                    </span>
                  </button>
                {/each}
              </div>
            </div>
          </div>
        </div>
      {/snippet}
    </Popover.Content>
  </Popover.Root>
</div>

<style>
  .roof-shape-select {
    width: 100%;
    display: grid;
  }

  .roof-shape-select-trigger {
    width: 100%;
    min-height: 4rem;
    padding: 0.56rem 0.65rem;
    border: 1px solid var(--panel-border);
    border-radius: 1rem;
    background: var(--panel-solid);
    text-align: left;
  }

  .roof-shape-select-trigger-copy {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
  }

  .roof-shape-select-trigger-thumb {
    flex: 0 0 auto;
    width: 3.4rem;
    aspect-ratio: 1 / 1;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: 0.85rem;
    border: 1px solid var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 72%, var(--muted-soft));
  }

  .roof-shape-select-trigger-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .roof-shape-option-thumb img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    padding: 0.12rem;
    box-sizing: border-box;
  }

  .roof-shape-select-trigger-thumb[data-empty='true'] {
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--panel-solid) 70%, var(--muted-soft)),
      color-mix(in srgb, var(--panel-solid) 84%, var(--accent-soft))
    );
  }

  .roof-shape-select-trigger-placeholder,
  .roof-shape-option-thumb-fallback,
  .roof-shape-option-thumb--empty {
    color: var(--muted-strong);
    font-size: 1.1rem;
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .roof-shape-select-trigger-text,
  .roof-shape-option-label {
    min-width: 0;
    color: var(--fg-strong);
    font-size: 0.94rem;
    font-weight: 700;
    line-height: 1.25;
    text-align: left;
    word-break: break-word;
  }

  .roof-shape-select-content {
    width: calc(var(--roof-shape-grid-width) + (2 * var(--roof-shape-content-padding)) + var(--roof-shape-scrollbar-width, 0px));
    max-width: calc(100dvw - 1rem);
    max-height: min(26rem, calc(100dvh - 7rem));
    padding: var(--roof-shape-content-padding);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .roof-shape-select-floating-wrapper {
    --roof-shape-grid-width: 300.8px;
    --roof-shape-content-padding: 11.2px;
    width: calc(var(--roof-shape-grid-width) + (2 * var(--roof-shape-content-padding)) + var(--roof-shape-scrollbar-width, 0px));
    min-width: calc(var(--roof-shape-grid-width) + (2 * var(--roof-shape-content-padding)) + var(--roof-shape-scrollbar-width, 0px));
    max-width: calc(100dvw - 1rem);
  }

  .roof-shape-select-scroll {
    width: calc(var(--roof-shape-grid-width) + var(--roof-shape-scrollbar-width, 0px));
    max-width: calc(var(--roof-shape-grid-width) + var(--roof-shape-scrollbar-width, 0px));
    max-height: inherit;
    overflow-x: hidden;
    overflow-y: auto;
    box-sizing: border-box;
    min-height: 0;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  .roof-shape-select-grid {
    display: grid;
    gap: 7.2px;
    width: var(--roof-shape-grid-width);
    min-width: var(--roof-shape-grid-width);
    max-width: var(--roof-shape-grid-width);
    grid-template-columns: repeat(5, 54.4px);
    justify-content: start;
  }

  .roof-shape-option-card {
    width: 54.4px;
    min-width: 54.4px;
    max-width: 54.4px;
    height: 54.4px;
    min-height: 54.4px;
    max-height: 54.4px;
    inline-size: 54.4px;
    block-size: 54.4px;
    justify-self: start;
    align-self: start;
    flex: 0 0 54.4px;
    display: grid;
    aspect-ratio: 1 / 1;
    gap: 0;
    justify-items: stretch;
    align-content: stretch;
    padding: 0;
    border: 0;
    border-radius: 0.95rem;
    background: transparent;
    box-shadow: none;
    overflow: hidden;
    cursor: pointer;
    appearance: none;
    outline: none;
  }

  .roof-shape-option-card[data-selected='true'] {
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  .roof-shape-option-card:hover {
    background: transparent;
    box-shadow: none;
  }

  .roof-shape-option-card:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 62%, transparent);
    outline-offset: 2px;
  }

  .roof-shape-option-thumb {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: inherit;
    border: 1px solid var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 70%, var(--muted-soft));
  }

  .roof-shape-option-card[data-selected='true'] .roof-shape-option-thumb {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--panel-border));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent);
  }

  .roof-shape-option-thumb--empty {
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--panel-solid) 66%, var(--muted-soft)),
      color-mix(in srgb, var(--panel-solid) 84%, var(--accent-soft))
    );
  }

  @media (max-width: 640px) {
    .roof-shape-select-trigger {
      min-height: 3.8rem;
      padding-inline: 0.55rem;
    }

    .roof-shape-select-trigger-thumb {
      width: 3rem;
    }

    .roof-shape-select-floating-wrapper {
      --roof-shape-content-padding: 9.6px;
      max-width: calc(100dvw - 0.75rem);
    }

    .roof-shape-select-content {
      max-width: calc(100dvw - 0.75rem);
      max-height: min(24rem, calc(100dvh - 5.5rem));
    }

    .roof-shape-select-scroll {
      width: calc(var(--roof-shape-grid-width) + var(--roof-shape-scrollbar-width, 0px));
      max-width: calc(var(--roof-shape-grid-width) + var(--roof-shape-scrollbar-width, 0px));
    }

    .roof-shape-option-thumb {
      width: 100%;
    }
  }
</style>
