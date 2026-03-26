<script>
  import { onMount } from 'svelte';

  import { t } from '$lib/i18n/index';
  import AdminFilterPresetsSection from './AdminFilterPresetsSection.svelte';
  import AdminFilterTagsSection from './AdminFilterTagsSection.svelte';

  export let controller;
  export let isMasterAdmin = false;

  const dataStatus = controller.dataStatus;

  onMount(() => {
    if (!isMasterAdmin) return;
    void controller.ensureLoaded({ preserveSelection: true });
  });
</script>

{#if !isMasterAdmin}
  <p class="mt-3 text-sm ui-text-muted">{$t('admin.settings.masterOnly')}</p>
{:else}
  <div class="mt-3 flex flex-col gap-4 min-w-0 min-h-0 overflow-hidden">
    <AdminFilterTagsSection {controller} />
    <AdminFilterPresetsSection {controller} />
    {#if $dataStatus}
      <p class="text-sm ui-text-muted px-1">{$dataStatus}</p>
    {/if}
  </div>
{/if}
