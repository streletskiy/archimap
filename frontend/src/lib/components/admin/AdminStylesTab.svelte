<script>
  import { onMount } from 'svelte';

  import { t, locale } from '$lib/i18n/index';
  import { apiJson } from '$lib/services/http';
  import { setStyleRegionOverrides } from '$lib/stores/style-overrides';
  import {
    getArchitectureStyleDefaultRules,
    toHumanArchitectureStyle
  } from '$lib/utils/architecture-style';
  import StyleDefaultsSection from './StyleDefaultsSection.svelte';
  import StyleOverridesDialog from './StyleOverridesDialog.svelte';
  import { UiButton } from '$lib/components/base';

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

  <StyleOverridesDialog
    bind:editorDialogOpen={editorDialogOpen}
    {editorStyleKey}
    {editorStyleLabel}
    {editorStyleRule}
    {editorStyleOverrides}
    {editorModeLabel}
    {editor}
    {status}
    {saving}
    {deletingId}
    onResetEditor={resetEditorForCurrentStyle}
    onUpdateEditor={updateEditor}
    onSave={saveEditorOverride}
    onOpenEditEditor={openEditEditor}
    onDeleteOverride={deleteOverride}
  />

  {#if loading}
    <p class="rounded-xl border border-dashed ui-border-strong px-3 py-4 text-sm ui-text-subtle">
      {$t('admin.styles.loading')}
    </p>
  {/if}

  <StyleDefaultsSection
    {defaultRules}
    {overridesByStyleKey}
    {saving}
    {deletingId}
    onOpenStyleEditor={openStyleEditor}
  />
</section>

