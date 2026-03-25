<script>
  import { Dialog as DialogRoot, DialogContent, DialogDescription, DialogTitle } from '$lib/components/ui/dialog';
  import { UiButton, UiInput } from '$lib/components/base';
  import { formatUiDate } from '$lib/utils/edit-ui';
  import { t } from '$lib/i18n/index';

  export let editorDialogOpen = false;
  export let editorStyleKey = '';
  export let editorStyleLabel = '';
  export let editorStyleRule = null;
  export let editorStyleOverrides = [];
  export let editorModeLabel = '';
  export let editor = null;
  export let status = '';
  export let saving = false;
  export let deletingId = null;
  export let onResetEditor = () => {};
  export let onUpdateEditor = () => {};
  export let onSave = () => {};
  export let onOpenEditEditor = () => {};
  export let onDeleteOverride = () => {};
</script>

<DialogRoot bind:open={editorDialogOpen}>
  {#if editorStyleKey}
    <DialogContent class="style-editor-dialog border ui-border p-0 sm:max-w-2xl">
      <div class="style-editor-dialog-surface space-y-5 p-5">
        <div class="space-y-2 pr-8">
          <DialogTitle class="text-base font-bold ui-text-strong">{$t('admin.styles.inline.editorDialogTitle')}</DialogTitle>
          <DialogDescription class="text-sm ui-text-muted">
            {$t('admin.styles.inline.selectedStyle')}: <span class="font-medium ui-text-strong">{editorStyleLabel}</span>
          </DialogDescription>

          <div class="flex flex-wrap gap-2 text-xs ui-text-subtle">
            <span class="rounded-full ui-surface-soft px-2 py-1">
              {editorStyleRule?.isGlobal ? $t('admin.styles.defaults.global') : $t('admin.styles.defaults.restricted')}
            </span>
            <span class="rounded-full ui-surface-soft px-2 py-1">
              {$t('admin.styles.inline.currentRulesCount', { count: editorStyleOverrides.length })}
            </span>
          </div>

          {#if editorStyleRule}
            <div class="rounded-xl ui-surface-soft px-3 py-2 text-sm ui-text-muted">
              {#if editorStyleRule.isGlobal}
                {$t('admin.styles.defaults.globalHint')}
              {:else}
                <div class="space-y-1.5">
                  {#if editorStyleRule.regionPatterns.length > 0}
                    <p class="text-[11px] uppercase tracking-[0.12em] ui-text-subtle">{$t('admin.styles.defaults.regionPatternsLabel')}</p>
                    <code>{editorStyleRule.regionPatterns.join(', ')}</code>
                  {/if}
                  {#if editorStyleRule.macroRegions.length > 0}
                    <p class="text-[11px] uppercase tracking-[0.12em] ui-text-subtle">{$t('admin.styles.defaults.macroRegionsLabel')}</p>
                    <code>{editorStyleRule.macroRegions.join(', ')}</code>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <section class="style-editor-card rounded-2xl p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="space-y-1">
              <h5 class="font-semibold ui-text-strong">
                {editor.sourceId ? $t('admin.styles.inline.editorEditTitle') : $t('admin.styles.inline.editorCreateTitle')}
              </h5>
              <p class="text-sm ui-text-muted">
                {$t('admin.styles.inline.actionTitle')}: <span class="font-medium ui-text-strong">{editorModeLabel}</span>
              </p>
            </div>
            {#if editor.sourceId}
              <UiButton type="button" variant="secondary" size="xs" disabled={saving || deletingId != null} onclick={() => onResetEditor('allow')}>
                {$t('admin.styles.inline.newRule')}
              </UiButton>
            {/if}
          </div>

          {#if status}
            <p class="mt-3 text-sm ui-text-muted">{status}</p>
          {/if}

          <label class="mt-4 block space-y-1 text-sm ui-text-body">
            <span>{$t('admin.styles.form.regionPattern')}</span>
            <UiInput
              value={editor.regionPattern}
              placeholder={$t('admin.styles.form.regionPatternPlaceholder')}
              oninput={(event) => onUpdateEditor({ regionPattern: event.currentTarget?.value || '' })}
            />
          </label>

          <div class="mt-4 space-y-2">
            <p class="text-sm ui-text-body">{$t('admin.styles.inline.actionTitle')}</p>
            <div class="flex flex-wrap gap-2">
              <UiButton
                type="button"
                size="xs"
                variant={editor.mode === 'allow' ? 'primary' : 'secondary'}
                aria-pressed={editor.mode === 'allow'}
                disabled={saving || deletingId != null}
                onclick={() => onUpdateEditor({ isAllowed: true, mode: 'allow' })}
              >
                {$t('admin.styles.allow')}
              </UiButton>
              <UiButton
                type="button"
                size="xs"
                variant={editor.mode === 'deny' ? 'danger' : 'secondary'}
                aria-pressed={editor.mode === 'deny'}
                disabled={saving || deletingId != null}
                onclick={() => onUpdateEditor({ isAllowed: false, mode: 'deny' })}
              >
                {$t('admin.styles.deny')}
              </UiButton>
              {#if !editor.sourceId}
                <UiButton
                  type="button"
                  size="xs"
                  variant={editor.mode === 'only' ? 'outline' : 'secondary'}
                  aria-pressed={editor.mode === 'only'}
                  disabled={saving || deletingId != null}
                  onclick={() => onUpdateEditor({ isAllowed: true, mode: 'only' })}
                >
                  {$t('admin.styles.inline.only')}
                </UiButton>
              {/if}
            </div>
          </div>

          <p class="mt-3 text-xs ui-text-subtle">
            {#if editor.mode === 'only'}
              {$t('admin.styles.inline.onlyHelp')}
            {:else if editor.isAllowed}
              {$t('admin.styles.inline.allowHelp')}
            {:else}
              {$t('admin.styles.inline.denyHelp')}
            {/if}
          </p>

          <div class="mt-4 flex flex-wrap gap-2">
            <UiButton
              type="button"
              disabled={saving || deletingId != null || !String(editor.regionPattern || '').trim()}
              onclick={onSave}
            >
              {saving
                ? $t('admin.styles.form.saving')
                : (editor.sourceId ? $t('admin.styles.inline.saveChanges') : (editor.mode === 'only' ? $t('admin.styles.inline.saveOnlyRule') : $t('admin.styles.inline.saveNewRule')))}
            </UiButton>
          </div>
        </section>

        <section class="space-y-3">
          <div class="space-y-1">
            <h5 class="font-semibold ui-text-strong">{$t('admin.styles.inline.currentRulesTitle')}</h5>
            <p class="text-sm ui-text-muted">{$t('admin.styles.inline.currentRulesDescription')}</p>
          </div>

          {#if editorStyleOverrides.length === 0}
            <p class="rounded-xl border border-dashed ui-border-strong px-3 py-4 text-sm ui-text-subtle">
              {$t('admin.styles.inline.noOverrides')}
            </p>
          {:else}
            <div class="space-y-2">
              {#each editorStyleOverrides as override (`style-dialog-override-${override.id}`)}
                <div class="style-override-inline-card">
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0 space-y-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <code>{override.region_pattern}</code>
                        <span class="style-override-pill rounded-full px-2.5 py-1 text-xs font-semibold" data-tone={override.is_allowed ? 'allow' : 'deny'}>
                          {override.is_allowed ? $t('admin.styles.allow') : $t('admin.styles.deny')}
                        </span>
                      </div>
                      <p class="text-xs ui-text-subtle">
                        {$t('admin.styles.table.updatedBy')}: {override.updated_by || '---'}
                        · {$t('admin.styles.table.createdAt')}: {formatUiDate(override.created_at) || '---'}
                      </p>
                    </div>

                    <div class="flex flex-wrap gap-2">
                      <UiButton
                        type="button"
                        variant="secondary"
                        size="xs"
                        disabled={saving || deletingId != null}
                        onclick={() => onOpenEditEditor(override)}
                      >
                        {$t('admin.styles.inline.edit')}
                      </UiButton>
                      <UiButton
                        type="button"
                        variant="danger"
                        size="xs"
                        disabled={saving || deletingId === override.id}
                        onclick={() => onDeleteOverride(override)}
                      >
                        {deletingId === override.id ? $t('admin.styles.table.deleting') : $t('admin.styles.table.delete')}
                      </UiButton>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    </DialogContent>
  {/if}
</DialogRoot>

<style>
  .style-editor-dialog-surface {
    background: var(--panel-solid);
  }

  .style-editor-card,
  .style-override-inline-card {
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
    box-shadow: var(--shadow-soft);
  }

  .style-override-inline-card {
    padding: 0.8rem 0.9rem;
  }

  .style-override-pill[data-tone='allow'] {
    background: #d1fae5;
    color: #047857;
  }

  .style-override-pill[data-tone='deny'] {
    background: #ffe4e6;
    color: #be123c;
  }

  :global(html[data-theme='dark']) .style-override-pill[data-tone='allow'] {
    background: #064e3b;
    color: #d1fae5;
  }

  :global(html[data-theme='dark']) .style-override-pill[data-tone='deny'] {
    background: #7f1d1d;
    color: #fecdd3;
  }
</style>

