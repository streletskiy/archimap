<script>
  import { t } from '$lib/i18n/index';
  import { UiButton, UiTable, UiTableBody, UiTableCell, UiTableHead, UiTableHeader, UiTableRow } from '$lib/components/base';

  export let defaultRules = [];
  export let overridesByStyleKey = {};
  export let saving = false;
  export let deletingId = null;
  export let onOpenStyleEditor = () => {};
</script>

<section class="style-defaults-card rounded-2xl p-4 min-w-0">
  <div class="space-y-1">
    <h4 class="text-base font-bold ui-text-strong">{$t('admin.styles.defaults.title')}</h4>
    <p class="text-sm ui-text-muted">{$t('admin.styles.defaults.description')}</p>
  </div>

  <div class="mt-4 space-y-3 lg:hidden">
    {#each defaultRules as item (`style-mobile-${item.value}`)}
      {@const styleOverrides = overridesByStyleKey[item.value] || []}
      {@const previewOverrides = styleOverrides.slice(0, 3)}
      {@const hiddenOverrideCount = styleOverrides.length > 3 ? (styleOverrides.length - 3) : 0}
      <article class="style-style-card rounded-2xl p-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0 space-y-1">
            <h5 class="font-semibold ui-text-strong">{item.label}</h5>
            <span class="style-default-pill rounded-full px-2.5 py-1 text-xs font-semibold" data-tone={item.isGlobal ? 'global' : 'restricted'}>
              {item.isGlobal ? $t('admin.styles.defaults.global') : $t('admin.styles.defaults.restricted')}
            </span>
          </div>
          <UiButton
            type="button"
            variant="secondary"
            size="xs"
            disabled={saving || deletingId != null}
            onclick={() => onOpenStyleEditor(item.value)}
          >
            {$t('admin.styles.inline.edit')}
          </UiButton>
        </div>

        <div class="mt-3 text-sm ui-text-muted">
          {#if item.isGlobal}
            {$t('admin.styles.defaults.globalHint')}
          {:else}
            <div class="space-y-1.5">
              {#if item.regionPatterns.length > 0}
                <p class="text-[11px] uppercase tracking-[0.12em] ui-text-subtle">{$t('admin.styles.defaults.regionPatternsLabel')}</p>
                <code>{item.regionPatterns.join(', ')}</code>
              {/if}
              {#if item.macroRegions.length > 0}
                <p class="text-[11px] uppercase tracking-[0.12em] ui-text-subtle">{$t('admin.styles.defaults.macroRegionsLabel')}</p>
                <code>{item.macroRegions.join(', ')}</code>
              {/if}
            </div>
          {/if}
        </div>

        <div class="mt-4 space-y-2">
          {#if styleOverrides.length === 0}
            <p class="text-sm ui-text-subtle">{$t('admin.styles.inline.noOverrides')}</p>
          {:else}
            <div class="flex flex-wrap gap-2">
              {#each previewOverrides as override (`style-mobile-preview-${override.id}`)}
                <span class="style-preview-pill">
                  <code>{override.region_pattern}</code>
                  <span class="style-override-pill rounded-full px-2 py-0.5 text-[10px] font-semibold" data-tone={override.is_allowed ? 'allow' : 'deny'}>
                    {override.is_allowed ? $t('admin.styles.allow') : $t('admin.styles.deny')}
                  </span>
                </span>
              {/each}
              {#if hiddenOverrideCount > 0}
                <span class="style-preview-pill ui-text-subtle">+{hiddenOverrideCount}</span>
              {/if}
            </div>
          {/if}
        </div>
      </article>
    {/each}
  </div>

  <div class="mt-4 hidden overflow-x-auto rounded-xl border ui-border ui-surface-base lg:block">
    <div class="min-w-[74rem]">
      <UiTable framed={false}>
        <UiTableHeader>
          <UiTableRow className="hover:[&>th]:bg-transparent">
            <UiTableHead>{$t('admin.styles.defaults.table.style')}</UiTableHead>
            <UiTableHead>{$t('admin.styles.defaults.table.mode')}</UiTableHead>
            <UiTableHead>{$t('admin.styles.defaults.table.regions')}</UiTableHead>
            <UiTableHead>{$t('admin.styles.defaults.table.overrides')}</UiTableHead>
          </UiTableRow>
        </UiTableHeader>
        <UiTableBody>
          {#each defaultRules as item (`style-default-${item.value}`)}
            {@const styleOverrides = overridesByStyleKey[item.value] || []}
            {@const previewOverrides = styleOverrides.slice(0, 3)}
            {@const hiddenOverrideCount = styleOverrides.length > 3 ? (styleOverrides.length - 3) : 0}
            <UiTableRow className="align-top">
              <UiTableCell className="font-medium ui-text-strong">{item.label}</UiTableCell>
              <UiTableCell className="align-top">
                <span class="style-default-pill rounded-full px-2.5 py-1 text-xs font-semibold" data-tone={item.isGlobal ? 'global' : 'restricted'}>
                  {item.isGlobal ? $t('admin.styles.defaults.global') : $t('admin.styles.defaults.restricted')}
                </span>
              </UiTableCell>
              <UiTableCell className="ui-text-muted align-top">
                {#if item.isGlobal}
                  {$t('admin.styles.defaults.globalHint')}
                {:else}
                  <div class="space-y-1.5">
                    {#if item.regionPatterns.length > 0}
                      <p class="text-[11px] uppercase tracking-[0.12em] ui-text-subtle">{$t('admin.styles.defaults.regionPatternsLabel')}</p>
                      <code>{item.regionPatterns.join(', ')}</code>
                    {/if}
                    {#if item.macroRegions.length > 0}
                      <p class="text-[11px] uppercase tracking-[0.12em] ui-text-subtle">{$t('admin.styles.defaults.macroRegionsLabel')}</p>
                      <code>{item.macroRegions.join(', ')}</code>
                    {/if}
                  </div>
                {/if}
              </UiTableCell>
              <UiTableCell className="align-top">
                <div class="space-y-3">
                  {#if styleOverrides.length === 0}
                    <p class="text-sm ui-text-subtle">{$t('admin.styles.inline.noOverrides')}</p>
                  {:else}
                    <div class="flex flex-wrap gap-2">
                      {#each previewOverrides as override (`style-override-preview-${override.id}`)}
                        <span class="style-preview-pill">
                          <code>{override.region_pattern}</code>
                          <span class="style-override-pill rounded-full px-2 py-0.5 text-[10px] font-semibold" data-tone={override.is_allowed ? 'allow' : 'deny'}>
                            {override.is_allowed ? $t('admin.styles.allow') : $t('admin.styles.deny')}
                          </span>
                        </span>
                      {/each}
                      {#if hiddenOverrideCount > 0}
                        <span class="style-preview-pill ui-text-subtle">+{hiddenOverrideCount}</span>
                      {/if}
                    </div>
                  {/if}

                  <UiButton
                    type="button"
                    variant="secondary"
                    size="xs"
                    disabled={saving || deletingId != null}
                    onclick={() => onOpenStyleEditor(item.value)}
                  >
                    {$t('admin.styles.inline.edit')}
                  </UiButton>
                </div>
              </UiTableCell>
            </UiTableRow>
          {/each}
        </UiTableBody>
      </UiTable>
    </div>
  </div>
</section>

<style>
  .style-defaults-card,
  .style-style-card {
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
    box-shadow: var(--shadow-soft);
  }

  .style-preview-pill {
    border: 1px solid var(--panel-border);
    border-radius: 0.95rem;
    background: var(--panel-solid);
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.35rem 0.55rem;
  }

  .style-override-pill[data-tone='allow'] {
    background: #d1fae5;
    color: #047857;
  }

  .style-override-pill[data-tone='deny'] {
    background: #ffe4e6;
    color: #be123c;
  }

  .style-default-pill[data-tone='global'] {
    background: #e2e8f0;
    color: #334155;
  }

  .style-default-pill[data-tone='restricted'] {
    background: #dbeafe;
    color: #1d4ed8;
  }

  :global(html[data-theme='dark']) .style-override-pill[data-tone='allow'] {
    background: #064e3b;
    color: #d1fae5;
  }

  :global(html[data-theme='dark']) .style-override-pill[data-tone='deny'] {
    background: #7f1d1d;
    color: #fecdd3;
  }

  :global(html[data-theme='dark']) .style-default-pill[data-tone='global'] {
    background: #334155;
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .style-default-pill[data-tone='restricted'] {
    background: #1d4ed8;
    color: #dbeafe;
  }
</style>

