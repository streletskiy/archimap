<script>
  import { UiTableCell, UiTableRow } from '$lib/components/base';
  import { cn } from '$lib/utils/ui.js';

  export let rows = 20;
  export let idLabel = 'ID';
  export let showSelection = false;
  export let showMarker = true;
  export let className = '';
  export let rowDelayMs = 40;

  $: loadingRows = Array.from({ length: Math.max(0, Math.trunc(Number(rows) || 0)) }, (_, index) => index);
</script>

{#each loadingRows as row (row)}
  <UiTableRow
    aria-hidden="true"
    className={cn('pointer-events-none select-none animate-pulse', className)}
    style={`animation-delay: ${row * rowDelayMs}ms;`}
  >
    {#if showSelection}
      <UiTableCell className="w-10">
        <span class="block h-4 w-4 rounded bg-black/10 dark:bg-white/10"></span>
      </UiTableCell>
    {/if}
    <UiTableCell className="min-w-0">
      <div class="flex min-w-0 flex-nowrap items-center gap-2">
        <span class="shrink-0 text-xs ui-text-subtle">{idLabel}:</span>
        <span class="h-4 w-[15ch] shrink-0 rounded-full bg-black/10 dark:bg-white/10"></span>
        <span class="min-w-0 flex-1 rounded-full bg-black/10 dark:bg-white/10" style="height: 0.95rem;"></span>
        {#if showMarker}
          <span class="shrink-0 h-6 w-8 rounded-md bg-black/10 dark:bg-white/10"></span>
        {/if}
      </div>
    </UiTableCell>
    <UiTableCell>
      <div class="h-4 w-[14ch] rounded-full bg-black/10 dark:bg-white/10"></div>
    </UiTableCell>
    <UiTableCell>
      <div class="h-4 w-[16ch] rounded-full bg-black/10 dark:bg-white/10"></div>
    </UiTableCell>
    <UiTableCell>
      <div class="h-6 w-[11ch] rounded-full bg-black/10 dark:bg-white/10"></div>
    </UiTableCell>
    <UiTableCell>
      <div class="flex flex-nowrap gap-2 overflow-hidden">
        <span class="h-5 w-[5ch] shrink-0 rounded-md bg-black/10 dark:bg-white/10"></span>
        <span class="h-5 w-[7ch] shrink-0 rounded-md bg-black/10 dark:bg-white/10"></span>
        <span class="h-5 w-[5ch] shrink-0 rounded-md bg-black/10 dark:bg-white/10"></span>
      </div>
    </UiTableCell>
  </UiTableRow>
{/each}
