<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import CalendarRangeIcon from '@lucide/svelte/icons/calendar-range';
  import { RangeCalendar } from '$lib/components/ui/range-calendar';
  import { cn } from '$lib/utils/ui.js';
  import { formatUiDateRangeLabel, resolveUiLocaleTag } from '$lib/utils/edit-ui';
  import UiButton from './UiButton.svelte';

  export let value = undefined;
  export let placeholder = '';
  export let calendarLabel = '';
  export let clearLabel = '';
  export let className = '';
  export let triggerClassName = '';
  export let panelClassName = '';
  export let locale = 'en';
  export let disabled = false;
  export let numberOfMonths = 1;
  export let onchange = undefined;

  const dispatch = createEventDispatcher();

  let open = false;
  let rootEl = null;

  $: localeTag = resolveUiLocaleTag(locale);
  $: weekStartsOn = localeTag.startsWith('ru') ? 1 : 0;
  $: displayLabel = formatUiDateRangeLabel(value, localeTag) || placeholder;

  function emitChange(nextValue) {
    const normalizedValue = nextValue?.start ? nextValue : undefined;
    const detail = { value: normalizedValue };
    onchange?.({ detail });
    dispatch('change', detail);
  }

  function handleValueChange(nextValue) {
    value = nextValue?.start ? nextValue : undefined;
    emitChange(value);
    if (value?.start && value?.end) {
      open = false;
    }
  }

  function clearValue() {
    value = undefined;
    emitChange(undefined);
  }

  function togglePanel() {
    if (disabled) return;
    open = !open;
  }

  function handleDocumentPointerDown(event) {
    if (!open || !rootEl) return;
    if (event.target instanceof Node && rootEl.contains(event.target)) return;
    open = false;
  }

  function handleDocumentKeydown(event) {
    if (event.key === 'Escape') {
      open = false;
    }
  }

  onMount(() => {
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    document.addEventListener('keydown', handleDocumentKeydown);
    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      document.removeEventListener('keydown', handleDocumentKeydown);
    };
  });
</script>

<div class={cn('relative', className)} bind:this={rootEl}>
  <button
    type="button"
    class={cn('ui-date-trigger', triggerClassName)}
    aria-expanded={open}
    aria-haspopup="dialog"
    {disabled}
    on:click={togglePanel}
  >
    <span class={cn('truncate', value?.start ? 'ui-text-body' : 'ui-text-muted')}>{displayLabel}</span>
    <CalendarRangeIcon class="size-4 shrink-0 opacity-70" />
  </button>

  {#if open}
    <div
      class={cn(
        'ui-date-panel ui-date-panel-dropdown ui-floating-layer-date-panel',
        panelClassName
      )}
    >
      <div class="mb-3 flex items-center justify-between gap-3">
        <p class="text-xs font-semibold uppercase tracking-[0.12em] ui-text-muted">
          {calendarLabel || placeholder}
        </p>
        {#if value?.start}
          <UiButton type="button" variant="secondary" size="xs" onclick={clearValue}>
            {clearLabel}
          </UiButton>
        {/if}
      </div>

      <RangeCalendar
        {value}
        onValueChange={handleValueChange}
        {numberOfMonths}
        {weekStartsOn}
        locale={localeTag}
        calendarLabel={calendarLabel || placeholder}
        weekdayFormat="short"
        fixedWeeks
        class="rounded-[0.95rem] border p-2 shadow-none [border-color:var(--panel-border)] [background:var(--panel-solid)]"
      />
    </div>
  {/if}
</div>
