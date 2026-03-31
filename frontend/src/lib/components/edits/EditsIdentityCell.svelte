<script>
  import { cn } from '$lib/utils/ui.js';

  export let idLabel = 'ID';
  export let osmType = '';
  export let osmId = '';
  export let address = '';
  export let markerText = '';
  export let markerTitle = '';
  export let markerClassName = '';
  export let showBadgesRow = false;
  export let className = '';

  $: normalizedAddress = String(address || '').trim() || '-';
  $: normalizedMarkerText = String(markerText || '').trim();
  $: normalizedOsmType = String(osmType || '').trim();
  $: normalizedOsmId = String(osmId || '').trim();
</script>

<div
  class={cn(
    'edits-identity-cell min-w-0',
    showBadgesRow ? 'edits-identity-cell--has-badges' : '',
    className
  )}
>
  <div class="edits-identity-cell__main flex min-w-0 flex-nowrap items-center gap-2">
    <span class="shrink-0 text-xs ui-text-subtle">{idLabel}: {normalizedOsmType}/{normalizedOsmId}</span>
    <p class="min-w-0 flex-1 font-semibold ui-text-strong break-words line-clamp-1">{normalizedAddress}</p>
    {#if normalizedMarkerText}
      <span
        class={cn('shrink-0 rounded-md ui-surface-soft px-2 py-1 text-[11px] font-semibold ui-text-muted', markerClassName)}
        title={markerTitle || undefined}
      >
        {normalizedMarkerText}
      </span>
    {/if}
  </div>
  {#if showBadgesRow}
    <div class="edits-identity-cell__badges">
      <slot name="badges" />
    </div>
  {/if}
</div>

<style>
  .edits-identity-cell {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
  }

  .edits-identity-cell__main {
    min-width: 0;
  }

  .edits-identity-cell__badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    min-width: 0;
  }

  @media (max-width: 767px) {
    .edits-identity-cell--has-badges {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .edits-identity-cell--has-badges .edits-identity-cell__main {
      flex: 1 1 auto;
    }

    .edits-identity-cell--has-badges .edits-identity-cell__badges {
      flex: 0 0 auto;
      flex-wrap: nowrap;
      white-space: nowrap;
    }
  }
</style>
