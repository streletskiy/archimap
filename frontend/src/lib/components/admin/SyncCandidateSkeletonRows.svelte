<script>
  import { UiTableCell, UiTableRow } from '$lib/components/base';

  export let rows = 20;
  export let showSelection = false;
  export let archived = false;
  export let className = '';
  export let rowDelayMs = 40;

  $: loadingRows = Array.from({ length: Math.max(0, Math.trunc(Number(rows) || 0)) }, (_, index) => index);
</script>

{#each loadingRows as row (row)}
  <UiTableRow
    aria-hidden="true"
    className={`pointer-events-none select-none animate-pulse ${className}`.trim()}
    style={`animation-delay: ${row * rowDelayMs}ms;`}
  >
    {#if !archived && showSelection}
      <UiTableCell className="w-10">
        <span class="block h-4 w-4 rounded bg-black/10 dark:bg-white/10"></span>
      </UiTableCell>
    {/if}
    <UiTableCell className="edits-list-identity-cell min-w-0">
      <div class="flex min-w-0 flex-nowrap items-center gap-2">
        <span class="shrink-0 text-xs ui-text-subtle">ID:</span>
        <span class="h-4 w-[12ch] shrink-0 rounded-full bg-black/10 dark:bg-white/10"></span>
        <span class="min-w-0 flex-1 rounded-full bg-black/10 dark:bg-white/10" style="height: 0.95rem;"></span>
      </div>
    </UiTableCell>
    <UiTableCell>
      <div class="h-4 w-[14ch] rounded-full bg-black/10 dark:bg-white/10"></div>
    </UiTableCell>
    <UiTableCell>
      <div class="h-6 w-[9ch] rounded-full bg-black/10 dark:bg-white/10"></div>
    </UiTableCell>
    <UiTableCell>
      <div class="h-4 w-[10ch] rounded-full bg-black/10 dark:bg-white/10"></div>
    </UiTableCell>
    <UiTableCell>
      <div class="flex flex-wrap gap-2">
        <span class="h-5 w-[5ch] rounded-md bg-black/10 dark:bg-white/10"></span>
        <span class="h-5 w-[7ch] rounded-md bg-black/10 dark:bg-white/10"></span>
        <span class="h-5 w-[7ch] rounded-md bg-black/10 dark:bg-white/10"></span>
      </div>
    </UiTableCell>
    <UiTableCell>
      <div class="flex flex-wrap gap-2">
        <span class="h-5 w-[7ch] rounded-md bg-black/10 dark:bg-white/10"></span>
        {#if !archived && showSelection}
          <span class="h-5 w-[7ch] rounded-md bg-black/10 dark:bg-white/10"></span>
        {/if}
      </div>
    </UiTableCell>
  </UiTableRow>
{/each}
