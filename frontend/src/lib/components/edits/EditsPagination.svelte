<script>
  import { UiButton } from '$lib/components/base';
  import { cn } from '$lib/utils/ui.js';

  export let page = 1;
  export let pageCount = 0;
  export let pageInfo = '';
  export let loading = false;
  export let previousLabel = 'Previous';
  export let nextLabel = 'Next';
  export let onPageChange = () => {};
  export let className = '';

  function buildPageNavItems(currentPage, totalPages) {
    const total = Math.max(0, Math.trunc(Number(totalPages) || 0));
    if (total <= 1) return [];

    const current = Math.max(1, Math.min(total, Math.trunc(Number(currentPage) || 1)));
    if (total <= 7) {
      return Array.from({ length: total }, (_, index) => index + 1);
    }

    const pages = new Set([1, total, current - 1, current, current + 1]);
    if (current <= 3) {
      pages.add(2);
      pages.add(3);
      pages.add(4);
    }
    if (current >= total - 2) {
      pages.add(total - 1);
      pages.add(total - 2);
      pages.add(total - 3);
    }

    const sorted = [...pages].filter((value) => value >= 1 && value <= total).sort((a, b) => a - b);
    const items = [];
    let prev = 0;
    for (const value of sorted) {
      if (prev > 0 && value - prev > 1) {
        items.push('ellipsis');
      }
      items.push(value);
      prev = value;
    }
    return items;
  }

  function goToPage(nextPage) {
    if (loading || nextPage === page) return;
    onPageChange(nextPage);
  }

  $: pageNavItems = buildPageNavItems(page, pageCount);
</script>

{#if pageCount > 1}
  <div class={cn('flex flex-wrap items-center justify-between gap-3 rounded-xl border ui-border ui-surface-muted px-3 py-2 text-sm ui-text-muted', className)}>
    <p class="whitespace-nowrap">{pageInfo}</p>
    <div class="flex flex-wrap items-center gap-2">
      {#each pageNavItems as item, index}
        {#if item === 'ellipsis'}
          <span class="px-1 text-xs ui-text-muted" aria-hidden="true">…</span>
        {:else}
          <UiButton
            type="button"
            variant={item === page ? 'secondary' : 'outline'}
            size="xs"
            disabled={loading || item === page}
            onclick={() => goToPage(item)}
          >
            {item}
          </UiButton>
        {/if}
      {/each}
      <UiButton
        type="button"
        variant="outline"
        size="xs"
        disabled={loading || page <= 1}
        onclick={() => goToPage(Math.max(1, page - 1))}
      >
        {previousLabel}
      </UiButton>
      <UiButton
        type="button"
        variant="outline"
        size="xs"
        disabled={loading || page >= pageCount}
        onclick={() => goToPage(Math.min(pageCount, page + 1))}
      >
        {nextLabel}
      </UiButton>
    </div>
  </div>
{/if}
