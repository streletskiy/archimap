<script>
  import { onMount } from 'svelte';

  import {
    UiButton,
    UiInput,
    UiTable,
    UiTableBody,
    UiTableCell,
    UiTableHead,
    UiTableHeader,
    UiTableRow
  } from '$lib/components/base';
  import { Dialog as DialogRoot, DialogContent, DialogDescription, DialogTitle } from '$lib/components/ui/dialog';
  import { locale, t } from '$lib/i18n/index';
  import { apiJson } from '$lib/services/http';
  import { setStyleRegionOverrides } from '$lib/stores/style-overrides';
  import {
    getArchitectureStyleDefaultRules,
    toHumanArchitectureStyle
  } from '$lib/utils/architecture-style';
  import { formatUiDate } from '$lib/utils/edit-ui';

  let items = [];
  let loading = false;
  let saving = false;
  let deletingId = null;
  let status = '';
  let editorDialogOpen = false;
  let editorDialogWasOpen;
  let editorStyleKey = '';
  let editor = createEditor();

  function createEditor({
    styleKey = '',
    sourceId = null,
    originalRegionPattern = '',
    regionPattern = '',
    isAllowed = true,
    mode = null
  } = {}) {
    const resolvedMode = String(mode || '').trim().toLowerCase() || (isAllowed ? 'allow' : 'deny');
    return {
      styleKey: String(styleKey || '').trim().toLowerCase(),
      sourceId: Number(sourceId || 0) || null,
      originalRegionPattern: String(originalRegionPattern || '').trim(),
      regionPattern: String(regionPattern || '').trim(),
      isAllowed: Boolean(isAllowed),
      mode: resolvedMode
    };
  }

  function normalizeRegionPatternText(value) {
    return String(value || '').trim().toLowerCase();
  }

  function getStyleLabel(styleKey) {
    return toHumanArchitectureStyle(styleKey, $locale) || styleKey;
  }

  function resetEditorForCurrentStyle(mode = 'allow') {
    const normalizedStyleKey = String(editorStyleKey || '').trim().toLowerCase();
    editor = createEditor({
      styleKey: normalizedStyleKey,
      isAllowed: mode !== 'deny',
      mode
    });
  }

  function openStyleEditor(styleKey) {
    const normalizedStyleKey = String(styleKey || '').trim().toLowerCase();
    if (!normalizedStyleKey) return;
    status = '';
    editorStyleKey = normalizedStyleKey;
    resetEditorForCurrentStyle('allow');
    editorDialogOpen = true;
  }

  function openEditEditor(item) {
    const overrideId = Number(item?.id || 0);
    const styleKey = String(item?.style_key || '').trim().toLowerCase();
    if (!overrideId || !styleKey) return;

    status = '';
    editorStyleKey = styleKey;
    editor = createEditor({
      styleKey,
      sourceId: overrideId,
      originalRegionPattern: item?.region_pattern,
      regionPattern: item?.region_pattern,
      isAllowed: item?.is_allowed,
      mode: item?.is_allowed ? 'allow' : 'deny'
    });
    editorDialogOpen = true;
  }

  function updateEditor(patch) {
    editor = {
      ...editor,
      ...patch
    };
  }

  function syncPublicOverrides(nextItems) {
    setStyleRegionOverrides((Array.isArray(nextItems) ? nextItems : []).map((item) => ({
      id: item.id,
      region_pattern: item.region_pattern,
      style_key: item.style_key,
      is_allowed: item.is_allowed
    })));
  }

  function sortOverrideItems(nextItems) {
    return [...(Array.isArray(nextItems) ? nextItems : [])].sort((left, right) => {
      const leftStyleKey = String(left?.style_key || '').trim().toLowerCase();
      const rightStyleKey = String(right?.style_key || '').trim().toLowerCase();
      if (leftStyleKey !== rightStyleKey) {
        return leftStyleKey.localeCompare(rightStyleKey);
      }

      const leftPattern = String(left?.region_pattern || '').trim().toLowerCase();
      const rightPattern = String(right?.region_pattern || '').trim().toLowerCase();
      if (leftPattern.length !== rightPattern.length) {
        return rightPattern.length - leftPattern.length;
      }
      if (leftPattern !== rightPattern) {
        return leftPattern.localeCompare(rightPattern);
      }

      return Number(right?.id || 0) - Number(left?.id || 0);
    });
  }

  function applyOverrideItems(nextItems) {
    items = sortOverrideItems(nextItems);
    syncPublicOverrides(items);
  }

  function normalizeOverrideItem(item) {
    if (!item || typeof item !== 'object') return null;
    const id = Number(item.id || 0);
    const styleKey = String(item.style_key || '').trim().toLowerCase();
    const regionPattern = String(item.region_pattern || '').trim().toLowerCase();
    if (!id || !styleKey || !regionPattern) return null;
    return {
      id,
      region_pattern: regionPattern,
      style_key: styleKey,
      is_allowed: Boolean(item.is_allowed),
      created_at: item.created_at ? String(item.created_at) : null,
      updated_by: item.updated_by ? String(item.updated_by) : null
    };
  }

  function upsertOverrideItem(item) {
    const normalized = normalizeOverrideItem(item);
    if (!normalized) return;

    const nextItems = [...items];
    const byIdIndex = nextItems.findIndex((entry) => Number(entry?.id || 0) === normalized.id);
    if (byIdIndex >= 0) {
      nextItems[byIdIndex] = normalized;
      applyOverrideItems(nextItems);
      return;
    }

    const byKeyIndex = nextItems.findIndex((entry) => (
      String(entry?.style_key || '').trim().toLowerCase() === normalized.style_key
      && String(entry?.region_pattern || '').trim().toLowerCase() === normalized.region_pattern
    ));
    if (byKeyIndex >= 0) {
      nextItems[byKeyIndex] = normalized;
      applyOverrideItems(nextItems);
      return;
    }

    nextItems.push(normalized);
    applyOverrideItems(nextItems);
  }

  function removeOverrideItem(overrideId) {
    const normalizedId = Number(overrideId || 0);
    if (!normalizedId) return;
    applyOverrideItems(items.filter((item) => Number(item?.id || 0) !== normalizedId));
  }

  async function loadOverrides() {
    loading = true;
    status = '';
    try {
      const data = await apiJson('/api/admin/style-overrides');
      applyOverrideItems(Array.isArray(data?.items) ? data.items : []);
    } catch (error) {
      status = String(error?.message || $t('admin.styles.loadFailed'));
    } finally {
      loading = false;
    }
  }

  async function saveEditorOverride() {
    const styleKey = String(editorStyleKey || editor.styleKey || '').trim().toLowerCase();
    const regionPattern = String(editor.regionPattern || '').trim();
    if (!styleKey || !regionPattern) return;

    saving = true;
    status = '';

    const hasSource = Number(editor.sourceId || 0) > 0;
    const replacedPattern = hasSource
      && normalizeRegionPatternText(editor.originalRegionPattern) !== normalizeRegionPatternText(regionPattern);

    let replacementSaved = false;

    try {
      if (editor.mode === 'only') {
        const denyResponse = await apiJson('/api/admin/style-overrides', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            override: {
              region_pattern: '*',
              style_key: styleKey,
              is_allowed: false
            }
          })
        });
        upsertOverrideItem(denyResponse?.item);

        const allowResponse = await apiJson('/api/admin/style-overrides', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            override: {
              region_pattern: regionPattern,
              style_key: styleKey,
              is_allowed: true
            }
          })
        });
        upsertOverrideItem(allowResponse?.item);
      } else {
        const saveResponse = await apiJson('/api/admin/style-overrides', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            override: {
              region_pattern: regionPattern,
              style_key: styleKey,
              is_allowed: editor.isAllowed
            }
          })
        });
        upsertOverrideItem(saveResponse?.item);
      }
      replacementSaved = true;

      // Region pattern participates in the upsert key, so renamed masks must remove the previous record explicitly.
      if (editor.mode !== 'only' && replacedPattern && hasSource) {
        await apiJson(`/api/admin/style-overrides/${editor.sourceId}`, {
          method: 'DELETE'
        });
        removeOverrideItem(editor.sourceId);
      }

      resetEditorForCurrentStyle('allow');
      status = $t('admin.styles.saved');
    } catch (error) {
      if (replacementSaved) {
        await loadOverrides();
        resetEditorForCurrentStyle('allow');
        status = String($t('admin.styles.inline.replaceCleanupFailed'));
      } else {
        status = String(error?.message || $t('admin.styles.saveFailed'));
      }
    } finally {
      saving = false;
    }
  }

  async function deleteOverride(item) {
    if (!item?.id) return;
    const confirmed = window.confirm($t('admin.styles.confirmDelete', {
      style: getStyleLabel(item.style_key),
      pattern: item.region_pattern
    }));
    if (!confirmed) return;

    deletingId = Number(item.id);
    status = '';
    try {
      await apiJson(`/api/admin/style-overrides/${item.id}`, {
        method: 'DELETE'
      });
      removeOverrideItem(item.id);
      if (Number(editor.sourceId || 0) === Number(item.id)) {
        resetEditorForCurrentStyle('allow');
      }
      status = $t('admin.styles.deleted');
    } catch (error) {
      status = String(error?.message || $t('admin.styles.deleteFailed'));
    } finally {
      deletingId = null;
    }
  }

  $: defaultRules = getArchitectureStyleDefaultRules($locale);
  $: restrictedDefaultRules = defaultRules.filter((item) => !item.isGlobal);
  $: globalDefaultRulesCount = defaultRules.length - restrictedDefaultRules.length;
  $: overridesByStyleKey = (Array.isArray(items) ? items : []).reduce((acc, item) => {
    const styleKey = String(item?.style_key || '').trim().toLowerCase();
    if (!styleKey) return acc;
    if (!acc[styleKey]) {
      acc[styleKey] = [];
    }
    acc[styleKey].push(item);
    return acc;
  }, {});
  $: editorStyleRule = defaultRules.find((item) => item.value === editorStyleKey) || null;
  $: editorStyleOverrides = overridesByStyleKey[editorStyleKey] || [];
  $: editorStyleLabel = editorStyleKey ? getStyleLabel(editorStyleKey) : '';
  $: editorModeLabel = editor.mode === 'only'
    ? $t('admin.styles.inline.only')
    : (editor.isAllowed ? $t('admin.styles.allow') : $t('admin.styles.deny'));
  $: if (editorDialogOpen) {
    editorDialogWasOpen = true;
  } else if (editorDialogWasOpen) {
    editorDialogWasOpen = false;
    editorStyleKey = '';
    editor = createEditor();
  }
  $: void editorDialogWasOpen;

  onMount(() => {
    void loadOverrides();
  });
</script>

<section class="mt-3 space-y-4 rounded-2xl border ui-border ui-surface-base p-4 min-w-0">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="space-y-1">
      <h3 class="text-base font-bold ui-text-strong">{$t('admin.styles.title')}</h3>
      <p class="text-sm ui-text-muted">{$t('admin.styles.subtitle')}</p>
    </div>
    <div class="flex flex-wrap gap-2">
      <UiButton type="button" variant="secondary" size="xs" onclick={loadOverrides} disabled={loading || saving || deletingId != null}>
        {$t('common.refresh')}
      </UiButton>
    </div>
  </div>

  <div class="flex flex-wrap gap-2 text-xs ui-text-subtle">
    <span class="rounded-full ui-surface-soft px-2 py-1">{$t('admin.styles.totalRules', { count: items.length })}</span>
    <span class="rounded-full ui-surface-soft px-2 py-1">{$t('admin.styles.defaultRestricted', { count: restrictedDefaultRules.length })}</span>
    <span class="rounded-full ui-surface-soft px-2 py-1">{$t('admin.styles.defaultGlobal', { count: globalDefaultRulesCount })}</span>
    <span class="rounded-full ui-surface-soft px-2 py-1">{$t('admin.styles.patternHint')}</span>
  </div>

  {#if status}
    <p class="text-sm ui-text-muted">{status}</p>
  {/if}

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
                <UiButton type="button" variant="secondary" size="xs" disabled={saving || deletingId != null} onclick={() => resetEditorForCurrentStyle('allow')}>
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
                oninput={(event) => updateEditor({ regionPattern: event.currentTarget?.value || '' })}
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
                  onclick={() => updateEditor({ isAllowed: true, mode: 'allow' })}
                >
                  {$t('admin.styles.allow')}
                </UiButton>
                <UiButton
                  type="button"
                  size="xs"
                  variant={editor.mode === 'deny' ? 'danger' : 'secondary'}
                  aria-pressed={editor.mode === 'deny'}
                  disabled={saving || deletingId != null}
                  onclick={() => updateEditor({ isAllowed: false, mode: 'deny' })}
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
                    onclick={() => updateEditor({ isAllowed: true, mode: 'only' })}
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
                onclick={saveEditorOverride}
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
                          onclick={() => openEditEditor(override)}
                        >
                          {$t('admin.styles.inline.edit')}
                        </UiButton>
                        <UiButton
                          type="button"
                          variant="danger"
                          size="xs"
                          disabled={saving || deletingId === override.id}
                          onclick={() => deleteOverride(override)}
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

  {#if loading}
    <p class="rounded-xl border border-dashed ui-border-strong px-3 py-4 text-sm ui-text-subtle">
      {$t('admin.styles.loading')}
    </p>
  {/if}

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
              onclick={() => openStyleEditor(item.value)}
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
                      onclick={() => openStyleEditor(item.value)}
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
</section>

<style>
  .style-defaults-card,
  .style-style-card,
  .style-editor-card {
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
    box-shadow: var(--shadow-soft);
  }

  .style-editor-dialog-surface {
    background: var(--panel-solid);
  }

  .style-override-inline-card,
  .style-preview-pill {
    border: 1px solid var(--panel-border);
    border-radius: 0.95rem;
    background: var(--panel-solid);
  }

  .style-override-inline-card {
    padding: 0.8rem 0.9rem;
  }

  .style-preview-pill {
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
    color: #a7f3d0;
  }

  :global(html[data-theme='dark']) .style-override-pill[data-tone='deny'] {
    background: #4c1024;
    color: #fecdd3;
  }

  :global(html[data-theme='dark']) .style-default-pill[data-tone='global'] {
    background: #18233a;
    color: #dbe5f2;
  }

  :global(html[data-theme='dark']) .style-default-pill[data-tone='restricted'] {
    background: #10213b;
    color: #93c5fd;
  }
</style>
