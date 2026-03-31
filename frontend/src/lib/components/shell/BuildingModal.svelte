<script>
  import { createEventDispatcher, tick } from 'svelte';
  import { page } from '$app/stores';
  import { fade, fly } from 'svelte/transition';
  import { UiBadge, UiButton, UiCheckbox, UiColorPicker, UiInput, UiScrollArea, UiSelect, UiTextarea } from '$lib/components/base';
  import { buildingModalOpen } from '$lib/stores/ui';
  import { selectedBuilding, selectedBuildings } from '$lib/stores/map';
  import { locale, t } from '$lib/i18n/index';
  import { buildAccountEditUrl } from '$lib/client/section-routes';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import BulkClearAction from '$lib/components/shell/BulkClearAction.svelte';
  import FormRow from '$lib/components/shell/FormRow.svelte';
  import { getArchitectureStyleOptions } from '$lib/utils/architecture-style';
  import { getBuildingMaterialOptions, toHumanBuildingMaterial } from '$lib/utils/building-material';
  import { filterBuildingEditedFields } from '$lib/utils/building-edit-fields';
  import { styleRegionOverrides } from '$lib/stores/style-overrides';
  import {
    buildAddressFromBuildingForm,
    buildBuildingComparableSnapshot,
    buildBulkBuildingFormState,
    createEmptyBuildingComparable,
    createEmptyBulkBuildingFieldState,
    createEmptyBuildingForm,
    getEditedBuildingFields,
    hydrateBuildingForm,
    resolveDisplayBuildingStyle
  } from '$lib/utils/building-mapper';
  import {
    formatDisplayText,
    pickFirstText
  } from '$lib/utils/text';

  export let buildingDetails = null;
  export let selectedBuildingDetails = [];
  export let isAuthenticated = false;
  export let canEditBuildings = false;
  export let savePending = false;
  export let saveStatus = '';

  const dispatch = createEventDispatcher();
  const buildingColourSwatches = [
    '#ffffff',
    '#e96b39',
    '#cf2f2f',
    '#7f0c0c',
    '#f6f0d0',
    '#7a7d80',
    '#cabc91',
    '#f3d36d',
    '#d8d8d8',
    '#81c476',
    '#7d5252',
    '#79abcb',
    '#d9d2c3',
    '#b5653b',
    '#a58a6a',
    '#8f9f8a',
    '#6b5b4b',
    '#4f4f4f'
  ];
  const BULK_FIELD_KEYS = Object.freeze([
    'name',
    'style',
    'design',
    'designRef',
    'designYear',
    'material',
    'colour',
    'levels',
    'yearBuilt',
    'architect',
    'address',
    'archimapDescription'
  ]);
  const BULK_TEXT_CLEARABLE_FIELDS = new Set([
    'design',
    'designRef',
    'designYear',
    'levels',
    'yearBuilt',
    'architect',
    'archimapDescription'
  ]);

  let form = createEmptyBuildingForm();
  let initialComparable = createEmptyBuildingComparable();
  let canEditAddressFull = true;
  let osmTagEntries = [];
  let bulkFieldState = createEmptyBulkBuildingFieldState();
  let bulkFieldOverrides = {};
  let bulkRegionSlugs = [];
  let modalEl = null;
  let hadOpenState;
  let canEditForm = false;
  let selectionState = {
    selectedBuildingItems: [],
    selectedBuildingCount: 0,
    isBulkSelection: false,
    isPartEditMode: false,
    editableEditedFields: [],
    hasEditableFields: false,
    bulkSelectionNotice: ''
  };

  function createEmptyBulkFieldOverrides() {
    return {
      name: false,
      style: false,
      design: false,
      designRef: false,
      designYear: false,
      material: false,
      colour: false,
      levels: false,
      yearBuilt: false,
      architect: false,
      address: false,
      archimapDescription: false
    };
  }

  function hydrateSingleForm(details) {
    const nextState = hydrateBuildingForm(details);
    form = nextState.form;
    initialComparable = nextState.initialComparable;
    canEditAddressFull = nextState.canEditAddressFull;
    osmTagEntries = nextState.osmTagEntries;
    bulkFieldState = createEmptyBulkBuildingFieldState();
    bulkFieldOverrides = createEmptyBulkFieldOverrides();
    bulkRegionSlugs = Array.isArray(details?.region_slugs) ? details.region_slugs : [];
  }

  function hydrateBulkForm(detailsList) {
    const nextState = buildBulkBuildingFormState(detailsList);
    form = nextState.form;
    initialComparable = nextState.initialComparable;
    canEditAddressFull = false;
    osmTagEntries = [];
    bulkFieldState = nextState.fieldState;
    bulkFieldOverrides = createEmptyBulkFieldOverrides();
    bulkRegionSlugs = Array.isArray(nextState.regionSlugs) ? nextState.regionSlugs : [];
  }

  function buildAddressFromForm(formValue = form) {
    return buildAddressFromBuildingForm(formValue);
  }

  function buildComparableSnapshot(formValue = form) {
    return buildBuildingComparableSnapshot(formValue);
  }

  function getEditedFields(currentSnapshot, initialSnapshot) {
    return getEditedBuildingFields(currentSnapshot, initialSnapshot);
  }

  function getBulkEditedFields(currentSnapshot, initialSnapshot, fieldState, overrides) {
    return BULK_FIELD_KEYS.filter((field) => {
      if (fieldState?.[field]?.isMixed) return Boolean(overrides?.[field]);
      return String(currentSnapshot?.[field] || '') !== String(initialSnapshot?.[field] || '');
    });
  }

  function markBulkFieldOverride(field) {
    if (!isBulkSelection || !field) return;
    if (bulkFieldOverrides?.[field]) return;
    bulkFieldOverrides = {
      ...bulkFieldOverrides,
      [field]: true
    };
  }

  function clearBulkField(field, formKey = field) {
    form = {
      ...form,
      [formKey]: ''
    };
    markBulkFieldOverride(field);
  }

  function handleColourChange(event) {
    form = {
      ...form,
      colour: String(event?.detail?.value || '')
    };
    markBulkFieldOverride('colour');
  }

  function handleDesignChange(event) {
    const checked = Boolean(event?.detail?.checked);
    const currentDesign = pickFirstText(form.design);
    form = {
      ...form,
      design: checked
        ? 'typical'
        : (currentDesign === 'typical' ? '' : currentDesign)
    };
    markBulkFieldOverride('design');
  }

  function resolveBulkFieldDisplayValue(field, value) {
    const normalized = pickFirstText(value);
    if (!normalized) return $t('buildingModal.notSpecified');
    if (field === 'style') return resolveDisplayStyle(normalized, $locale) || normalized;
    if (field === 'material') return toHumanBuildingMaterial(normalized, $locale) || normalized;
    return normalized;
  }

  function getBulkFieldPreview(field) {
    const sampleValues = Array.isArray(bulkFieldState?.[field]?.sampleValues)
      ? bulkFieldState[field].sampleValues
      : [];
    const labels = [];
    const seen = new Set();
    for (const value of sampleValues) {
      const label = resolveBulkFieldDisplayValue(field, value);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
    }
    const visibleLabels = labels.slice(0, 3);
    if (labels.length > visibleLabels.length) {
      visibleLabels.push($t('buildingModal.bulkMixedValuesMore', {
        count: labels.length - visibleLabels.length
      }));
    }
    return visibleLabels.join(', ');
  }

  function getBulkFieldNote(field) {
    if (!isBulkSelection || !bulkFieldState?.[field]?.isMixed) return '';
    const values = getBulkFieldPreview(field);
    return values
      ? $t('buildingModal.bulkMixedValues', { values })
      : $t('buildingModal.mixedValuesLabel');
  }

  function getFieldPlaceholder(field) {
    if (isBulkSelection && bulkFieldState?.[field]?.isMixed) {
      return $t('buildingModal.bulkMixedPlaceholder');
    }
    return $t('buildingModal.notSpecified');
  }

  function getTextFieldPlaceholder(field) {
    return isBulkSelection && bulkFieldState?.[field]?.isMixed
      ? $t('buildingModal.bulkMixedPlaceholder')
      : '';
  }

  function getSummaryValue(field, value) {
    if (isBulkSelection && bulkFieldState?.[field]?.isMixed) {
      return $t('buildingModal.mixedValuesLabel');
    }
    return pickFirstText(value);
  }

  function shouldShowBulkClearAction(field, currentValue = '') {
    return isBulkSelection
      && BULK_TEXT_CLEARABLE_FIELDS.has(field)
      && (bulkFieldState?.[field]?.isMixed || Boolean(pickFirstText(currentValue)));
  }

  function isOverpassBuilding(details = buildingDetails) {
    return String(details?.source || details?.properties?.source || '').trim().toLowerCase() === 'overpass';
  }

  $: currentComparable = buildComparableSnapshot(form);
  $: selectedBuildingItems = Array.isArray($selectedBuildings) && $selectedBuildings.length > 0
    ? $selectedBuildings
    : ($selectedBuilding?.osmType && $selectedBuilding?.osmId
      ? [{
          osmType: $selectedBuilding.osmType,
          osmId: Number($selectedBuilding.osmId),
          lon: $selectedBuilding?.lon == null || $selectedBuilding?.lon === ''
            ? null
            : (Number.isFinite(Number($selectedBuilding.lon)) ? Number($selectedBuilding.lon) : null),
          lat: $selectedBuilding?.lat == null || $selectedBuilding?.lat === ''
            ? null
            : (Number.isFinite(Number($selectedBuilding.lat)) ? Number($selectedBuilding.lat) : null),
          featureKind: null
        }]
      : []);
  $: selectedBuildingCount = selectedBuildingItems.length;
  $: isBulkSelection = selectedBuildingCount > 1;
  $: bulkDetailsReady = !isBulkSelection || (
    Array.isArray(selectedBuildingDetails) && selectedBuildingDetails.length === selectedBuildingCount
  );
  $: isPartEditMode = (buildingDetails?.feature_kind === 'building_part')
    || selectedBuildingItems.some((item) => item?.featureKind === 'building_part');
  $: editedFields = isBulkSelection
    ? getBulkEditedFields(currentComparable, initialComparable, bulkFieldState, bulkFieldOverrides)
    : getEditedFields(currentComparable, initialComparable);
  $: editableEditedFields = filterBuildingEditedFields(editedFields, {
    isBulkSelection,
    hasBuildingPartSelection: isPartEditMode
  });
  $: selectionState = {
    selectedBuildingItems,
    selectedBuildingCount,
    isBulkSelection,
    isPartEditMode,
    editableEditedFields,
    hasEditableFields: editableEditedFields.length > 0,
    bulkSelectionNotice: isBulkSelection
      ? (isPartEditMode
        ? $t('buildingModal.bulkSelectionPartNotice')
        : $t('buildingModal.bulkSelectionNotice'))
      : ''
  };

  function submitEdit(event) {
    event.preventDefault();
    const selection = $selectedBuilding;
    if (!selection?.osmType || !selection?.osmId || !canEditForm || savePending) return;
    if (!selectionState.hasEditableFields) return;
    const snapshot = currentComparable;
    dispatch('save', {
      osmType: selection.osmType,
      osmId: Number(selection.osmId),
      name: snapshot.name,
      style: snapshot.style,
      design: snapshot.design,
      designRef: snapshot.designRef,
      designYear: snapshot.designYear,
      material: snapshot.material,
      colour: snapshot.colour,
      levels: snapshot.levels,
      yearBuilt: snapshot.yearBuilt,
      architect: snapshot.architect,
      address: snapshot.address,
      archimapDescription: snapshot.archimapDescription,
      editedFields: selectionState.editableEditedFields
    });
  }

  function closeOnKeydown(event) {
    if (event.key === 'Escape') {
      dispatch('close');
    }
  }

  function closeModal() {
    dispatch('close');
  }

  function resolveDisplayStyle(value, localeValue) {
    return resolveDisplayBuildingStyle(value, localeValue);
  }

  $: if ($buildingModalOpen && !isBulkSelection && buildingDetails) {
    hydrateSingleForm(buildingDetails);
  }

  $: if ($buildingModalOpen && isBulkSelection && bulkDetailsReady) {
    hydrateBulkForm(selectedBuildingDetails);
  }

  $: if ($buildingModalOpen && !hadOpenState) {
    hadOpenState = true;
    tick().then(() => modalEl?.focus());
  } else if (!$buildingModalOpen && hadOpenState) {
    hadOpenState = false;
  }
  $: void hadOpenState;
  $: canEditForm = Boolean(canEditBuildings);

  $: archiInfo = buildingDetails?.properties?.archiInfo || {};
  $: buildingKey = !isBulkSelection && $selectedBuilding?.osmType && $selectedBuilding?.osmId
    ? `${$selectedBuilding.osmType}/${$selectedBuilding.osmId}`
    : '';
  $: reviewStatus = String(buildingDetails?.review_status || '').trim().toLowerCase();
  $: pendingEditId = Number(buildingDetails?.user_edit_id || 0);
  $: hasPendingEdit = !isBulkSelection && reviewStatus === 'pending' && Number.isInteger(pendingEditId) && pendingEditId > 0;
  $: pendingEditUrl = hasPendingEdit ? buildAccountEditUrl($page.url, pendingEditId) : null;
  $: pendingEditHref = pendingEditUrl
    ? `${pendingEditUrl.pathname}${pendingEditUrl.search}${pendingEditUrl.hash}`
    : '';
  $: displayName = isBulkSelection
    ? (!bulkDetailsReady || bulkFieldState?.name?.isMixed
      ? $t('buildingModal.bulkSelectionTitle')
      : (pickFirstText(form.name) || $t('buildingModal.bulkSelectionTitle')))
    : (pickFirstText(form.name, archiInfo.name) || buildingKey || $t('buildingModal.title'));
  $: displayAddress = isBulkSelection ? '' : pickFirstText(buildAddressFromForm(), archiInfo.address);
  $: displayStyleRaw = isBulkSelection
    ? pickFirstText(form.style)
    : pickFirstText(form.style, archiInfo.styleRaw, archiInfo.style);
  $: displayStyle = resolveDisplayStyle(displayStyleRaw, $locale);
  $: displayDesign = isBulkSelection
    ? pickFirstText(form.design)
    : pickFirstText(form.design, archiInfo.design);
  $: displayDesignRef = isBulkSelection
    ? pickFirstText(form.designRef)
    : pickFirstText(form.designRef, archiInfo.design_ref);
  $: displayDesignYear = isBulkSelection
    ? pickFirstText(form.designYear)
    : pickFirstText(form.designYear, archiInfo.design_year);
  $: displayMaterialRaw = isBulkSelection
    ? pickFirstText(form.material)
    : pickFirstText(form.material, archiInfo.material);
  $: displayMaterial = displayMaterialRaw
    ? (toHumanBuildingMaterial(displayMaterialRaw, $locale) || displayMaterialRaw)
    : '';
  $: displayColour = isBulkSelection ? pickFirstText(form.colour) : pickFirstText(form.colour, archiInfo.colour);
  $: displayDescription = isBulkSelection
    ? (bulkFieldState?.archimapDescription?.isMixed ? '' : pickFirstText(form.archimapDescription))
    : pickFirstText(form.archimapDescription, archiInfo.archimap_description, archiInfo.description);
  $: currentRegionSlugs = isBulkSelection
    ? bulkRegionSlugs
    : (Array.isArray(buildingDetails?.region_slugs) ? buildingDetails.region_slugs : []);
  $: availableArchitectureStyleItems = getArchitectureStyleOptions($locale, currentRegionSlugs, $styleRegionOverrides).map((option) => ({
    value: option.value,
    label: option.label
  }));
  $: currentArchitectureStyleItem = form.style
    ? (getArchitectureStyleOptions($locale).find((option) => option.value === form.style) || {
      value: form.style,
      label: resolveDisplayStyle(form.style, $locale) || form.style
    })
    : null;
  $: architectureStyleItems = currentArchitectureStyleItem
    && !availableArchitectureStyleItems.some((option) => option.value === currentArchitectureStyleItem.value)
    ? [currentArchitectureStyleItem, ...availableArchitectureStyleItems]
    : availableArchitectureStyleItems;
  $: availableBuildingMaterialItems = getBuildingMaterialOptions($locale);
  $: currentBuildingMaterialItem = form.material
    ? (availableBuildingMaterialItems.find((option) => option.value === form.material) || {
      value: form.material,
      label: toHumanBuildingMaterial(form.material, $locale) || form.material
    })
    : null;
  $: buildingMaterialItems = currentBuildingMaterialItem
    && !availableBuildingMaterialItems.some((option) => option.value === currentBuildingMaterialItem.value)
    ? [currentBuildingMaterialItem, ...availableBuildingMaterialItems]
    : availableBuildingMaterialItems;
  $: rawDesignRefSuggestions = isBulkSelection
    ? selectedBuildingDetails?.[0]?.design_ref_suggestions
    : buildingDetails?.design_ref_suggestions;
  $: designRefSuggestions = Array.isArray(rawDesignRefSuggestions)
    ? Array.from(new Set(rawDesignRefSuggestions.map((value) => pickFirstText(value)).filter(Boolean)))
    : [];
  $: designCheckboxChecked = pickFirstText(displayDesign) === 'typical';
  $: designFieldsEnabled = designCheckboxChecked;
  $: designCheckboxIndeterminate = Boolean(
    isBulkSelection
      && bulkFieldState?.design?.isMixed
      && !bulkFieldOverrides?.design
      && !pickFirstText(displayDesign)
  );
  $: hasReadyDetails = isBulkSelection ? bulkDetailsReady : Boolean(buildingDetails);
  $: summaryItems = [
    { label: $t('buildingModal.style'), value: getSummaryValue('style', displayStyle) },
    {
      label: designCheckboxChecked ? $t('buildingModal.designBuilding') : $t('buildingModal.design'),
      value: designCheckboxChecked ? $t('common.yes') : getSummaryValue('design', displayDesign)
    },
    { label: $t('buildingModal.designRef'), value: getSummaryValue('designRef', displayDesignRef) },
    { label: $t('buildingModal.designYear'), value: getSummaryValue('designYear', displayDesignYear) },
    { label: $t('buildingModal.material'), value: getSummaryValue('material', displayMaterial) },
    { label: $t('buildingModal.colour'), value: getSummaryValue('colour', displayColour) },
    { label: $t('buildingModal.levels'), value: getSummaryValue('levels', isBulkSelection ? form.levels : pickFirstText(form.levels, archiInfo.levels)) },
    { label: $t('buildingModal.yearBuilt'), value: getSummaryValue('yearBuilt', isBulkSelection ? form.yearBuilt : pickFirstText(form.yearBuilt, archiInfo.year_built)) },
    { label: $t('buildingModal.architect'), value: getSummaryValue('architect', isBulkSelection ? form.architect : pickFirstText(form.architect, archiInfo.architect)) }
  ].filter((item) => pickFirstText(item.value));
  $: hasOverviewContent = Boolean(displayDescription || summaryItems.length > 0);
</script>

{#if $buildingModalOpen}
  <div
    class="backdrop"
    in:fade={{ duration: 160 }}
    out:fade={{ duration: 150 }}
  >
    <div
      id="building-modal"
      class="modal"
      bind:this={modalEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby="building-modal-title"
      tabindex="-1"
      on:keydown={closeOnKeydown}
      in:fly={{ x: 22, y: -4, duration: 220, opacity: 0.18 }}
      out:fly={{ x: 22, y: -4, duration: 180, opacity: 0.18 }}
    >
      <header class="modal-header">
        <div class="modal-header-copy">
          <p class="ui-kicker">{$t('buildingModal.overview')}</p>
          <h3 id="building-modal-title">{displayName}</h3>
          <div class="modal-header-meta">
            {#if selectionState.isBulkSelection}
              <UiBadge
                variant="info"
                className="inline-flex items-center rounded-full px-[0.72rem] py-[0.42rem] text-[0.78rem] font-bold"
              >
                {$t('buildingModal.bulkSelectionLabel', { count: selectionState.selectedBuildingCount })}
              </UiBadge>
            {:else}
              <UiBadge
                variant="accent"
                className="inline-flex items-center rounded-full px-[0.72rem] py-[0.42rem] text-[0.78rem] font-bold [background:var(--accent-soft)] [color:var(--accent-ink)]"
              >
                {buildingKey}
              </UiBadge>
              {#if isOverpassBuilding()}
                <UiBadge
                  variant="default"
                  className="inline-flex items-center rounded-full px-[0.72rem] py-[0.42rem] text-[0.78rem] font-bold"
                >
                  {$t('buildingModal.cachedOverpass')}
                </UiBadge>
              {/if}
              {#if hasPendingEdit}
                <UiBadge
                  href={pendingEditHref}
                  variant="warning"
                  className="inline-flex items-center rounded-full px-[0.72rem] py-[0.42rem] text-[0.78rem] font-bold cursor-pointer"
                  title={$t('buildingModal.pendingEditOpen')}
                >
                  {$t('buildingModal.pendingEdit')}
                </UiBadge>
              {/if}
            {/if}
            {#if !selectionState.isBulkSelection && displayAddress}
              <span class="modal-address">{displayAddress}</span>
            {/if}
          </div>
        </div>

        <UiButton
          type="button"
          variant="secondary"
          size="close"
          onclick={closeModal}
          aria-label={$t('common.close')}
        >
          <CloseIcon class="ui-close-icon" />
        </UiButton>
      </header>

      {#if hasReadyDetails}
        {#if hasOverviewContent}
          <section class="overview-card">
            <div class="overview-head">
              <div>
                <h4>{$t('buildingModal.title')}</h4>
                {#if displayDescription}
                  <p>{displayDescription}</p>
                {/if}
              </div>
            </div>

            {#if summaryItems.length > 0}
              <div class="overview-grid">
                {#each summaryItems as item}
                  <article class="overview-stat">
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </article>
                {/each}
              </div>
            {/if}
          </section>
        {/if}

        {#if selectionState.isBulkSelection}
          <section class="bulk-selection-note" aria-live="polite">
            <strong>{selectionState.bulkSelectionNotice}</strong>
          </section>
        {/if}

            {#if canEditForm}
              <form class="edit-form" on:submit={submitEdit}>
            <section class="form-section">
              <div class="section-head">
                <h4>{$t('buildingModal.primarySection')}</h4>
              </div>

              {#if selectionState.isPartEditMode}
                <div class="grid2">
                  <FormRow
                    forId="building-levels"
                    label={$t('buildingModal.levels')}
                    note={getBulkFieldNote('levels')}
                  >
                    <BulkClearAction
                      show={shouldShowBulkClearAction('levels', form.levels)}
                      ariaLabel={$t('buildingModal.bulkClearField')}
                      title={$t('buildingModal.bulkClearField')}
                      onclick={() => clearBulkField('levels')}
                    >
                      <UiInput
                        id="building-levels"
                        type="number"
                        min="0"
                        max="300"
                        bind:value={form.levels}
                        placeholder={getTextFieldPlaceholder('levels')}
                        oninput={() => markBulkFieldOverride('levels')}
                      />
                    </BulkClearAction>
                  </FormRow>

                  <FormRow
                    forId="building-year"
                    label={$t('buildingModal.yearBuilt')}
                    note={getBulkFieldNote('yearBuilt')}
                  >
                    <BulkClearAction
                      show={shouldShowBulkClearAction('yearBuilt', form.yearBuilt)}
                      ariaLabel={$t('buildingModal.bulkClearField')}
                      title={$t('buildingModal.bulkClearField')}
                      onclick={() => clearBulkField('yearBuilt')}
                    >
                      <UiInput
                        id="building-year"
                        type="number"
                        min="1000"
                        max="2100"
                        bind:value={form.yearBuilt}
                        placeholder={getTextFieldPlaceholder('yearBuilt')}
                        oninput={() => markBulkFieldOverride('yearBuilt')}
                      />
                    </BulkClearAction>
                  </FormRow>
                </div>

                <FormRow
                  forId="building-style-select"
                  label={$t('buildingModal.style')}
                  note={getBulkFieldNote('style')}
                >
                  <UiSelect
                    items={[{ value: '', label: $t('buildingModal.notSpecified') }, ...architectureStyleItems]}
                    bind:value={form.style}
                    placeholder={getFieldPlaceholder('style')}
                    contentClassName="ui-floating-layer-building-modal"
                    onchange={() => markBulkFieldOverride('style')}
                  />
                </FormRow>

                <FormRow
                  forId="building-material-select"
                  label={$t('buildingModal.material')}
                  note={getBulkFieldNote('material')}
                >
                  <UiSelect
                    items={[{ value: '', label: $t('buildingModal.notSpecified') }, ...buildingMaterialItems]}
                    bind:value={form.material}
                    placeholder={getFieldPlaceholder('material')}
                    contentClassName="ui-floating-layer-building-modal"
                    onchange={() => markBulkFieldOverride('material')}
                  />
                </FormRow>

                <FormRow
                  forId="building-colour"
                  label={$t('buildingModal.colour')}
                  note={getBulkFieldNote('colour')}
                >
                  <BulkClearAction
                    show={selectionState.isBulkSelection && shouldShowBulkClearAction('colour', form.colour)}
                      ariaLabel={$t('buildingModal.bulkClearField')}
                      title={$t('buildingModal.bulkClearField')}
                      onclick={() => clearBulkField('colour')}
                    >
                      <div class="colour-picker-row">
                      <UiColorPicker
                        value={form.colour}
                          label={$t('buildingModal.colour')}
                          swatches={buildingColourSwatches}
                          contentClassName="ui-floating-layer-building-modal"
                          onchange={handleColourChange}
                        />
                      {#if !selectionState.isBulkSelection}
                        <UiButton
                          type="button"
                          variant="secondary"
                          size="xs"
                          disabled={!form.colour}
                          onclick={() => clearBulkField('colour')}
                        >
                          {$t('common.clear')}
                        </UiButton>
                      {/if}
                    </div>
                  </BulkClearAction>
                </FormRow>
              {:else}
                {#if !selectionState.isBulkSelection}
                  <FormRow
                    forId="building-name"
                    label={$t('buildingModal.name')}
                  >
                    <UiInput id="building-name" type="text" bind:value={form.name} />
                  </FormRow>
                {/if}

                <div class="grid2">
                  <FormRow
                    forId="building-levels"
                    label={$t('buildingModal.levels')}
                    note={getBulkFieldNote('levels')}
                  >
                    <BulkClearAction
                      show={shouldShowBulkClearAction('levels', form.levels)}
                      ariaLabel={$t('buildingModal.bulkClearField')}
                      title={$t('buildingModal.bulkClearField')}
                      onclick={() => clearBulkField('levels')}
                    >
                      <UiInput
                        id="building-levels"
                        type="number"
                      min="0"
                      max="300"
                      bind:value={form.levels}
                      placeholder={getTextFieldPlaceholder('levels')}
                      oninput={() => markBulkFieldOverride('levels')}
                    />
                    </BulkClearAction>
                  </FormRow>

                  <FormRow
                    forId="building-year"
                    label={$t('buildingModal.yearBuilt')}
                    note={getBulkFieldNote('yearBuilt')}
                  >
                    <BulkClearAction
                      show={shouldShowBulkClearAction('yearBuilt', form.yearBuilt)}
                      ariaLabel={$t('buildingModal.bulkClearField')}
                      title={$t('buildingModal.bulkClearField')}
                      onclick={() => clearBulkField('yearBuilt')}
                    >
                      <UiInput
                        id="building-year"
                        type="number"
                      min="1000"
                      max="2100"
                      bind:value={form.yearBuilt}
                      placeholder={getTextFieldPlaceholder('yearBuilt')}
                      oninput={() => markBulkFieldOverride('yearBuilt')}
                    />
                    </BulkClearAction>
                  </FormRow>
                </div>

                <FormRow
                  forId="building-architect"
                  label={$t('buildingModal.architect')}
                  note={getBulkFieldNote('architect')}
                >
                  <BulkClearAction
                    show={shouldShowBulkClearAction('architect', form.architect)}
                    ariaLabel={$t('buildingModal.bulkClearField')}
                    title={$t('buildingModal.bulkClearField')}
                    onclick={() => clearBulkField('architect')}
                  >
                    <UiInput
                      id="building-architect"
                      type="text"
                      bind:value={form.architect}
                      placeholder={getTextFieldPlaceholder('architect')}
                      oninput={() => markBulkFieldOverride('architect')}
                    />
                  </BulkClearAction>
                </FormRow>

                <FormRow
                  forId="building-style-select"
                  label={$t('buildingModal.style')}
                  note={getBulkFieldNote('style')}
                >
                  <UiSelect
                    items={[{ value: '', label: $t('buildingModal.notSpecified') }, ...architectureStyleItems]}
                    bind:value={form.style}
                    placeholder={getFieldPlaceholder('style')}
                    contentClassName="ui-floating-layer-building-modal"
                    onchange={() => markBulkFieldOverride('style')}
                  />
                </FormRow>

                <FormRow
                  forId="building-design"
                  label={$t('buildingModal.design')}
                  note={getBulkFieldNote('design')}
                >
                  <BulkClearAction
                    show={shouldShowBulkClearAction('design', form.design)}
                    ariaLabel={$t('buildingModal.bulkClearField')}
                    title={$t('buildingModal.bulkClearField')}
                    onclick={() => clearBulkField('design')}
                  >
                    <div class="design-toggle-row">
                      <UiCheckbox
                        checked={designCheckboxChecked}
                        indeterminate={designCheckboxIndeterminate}
                        className="design-toggle-checkbox"
                        onchange={handleDesignChange}
                      />
                      {#if displayDesign && displayDesign !== 'typical'}
                        <UiInput
                          value={displayDesign}
                          readonly
                          className="design-toggle-value-input"
                        />
                      {/if}
                    </div>
                  </BulkClearAction>
                </FormRow>

                <div class="grid2">
                  <FormRow
                    forId="building-design-ref"
                    label={$t('buildingModal.designRef')}
                    note={getBulkFieldNote('designRef')}
                  >
                    <BulkClearAction
                      show={designFieldsEnabled && shouldShowBulkClearAction('designRef', form.designRef)}
                      ariaLabel={$t('buildingModal.bulkClearField')}
                      title={$t('buildingModal.bulkClearField')}
                      onclick={() => clearBulkField('designRef')}
                    >
                      <UiInput
                        id="building-design-ref"
                        type="text"
                        list="building-design-ref-suggestions"
                        bind:value={form.designRef}
                        disabled={!designFieldsEnabled}
                        placeholder={getTextFieldPlaceholder('designRef')}
                        oninput={() => markBulkFieldOverride('designRef')}
                      />
                    </BulkClearAction>
                  </FormRow>

                  <FormRow
                    forId="building-design-year"
                    label={$t('buildingModal.designYear')}
                    note={getBulkFieldNote('designYear')}
                  >
                    <BulkClearAction
                      show={designFieldsEnabled && shouldShowBulkClearAction('designYear', form.designYear)}
                      ariaLabel={$t('buildingModal.bulkClearField')}
                      title={$t('buildingModal.bulkClearField')}
                      onclick={() => clearBulkField('designYear')}
                    >
                      <UiInput
                        id="building-design-year"
                        type="number"
                        min="1000"
                        max="2100"
                        bind:value={form.designYear}
                        disabled={!designFieldsEnabled}
                        placeholder={getTextFieldPlaceholder('designYear')}
                        oninput={() => markBulkFieldOverride('designYear')}
                      />
                    </BulkClearAction>
                  </FormRow>
                </div>

                <FormRow
                  forId="building-material-select"
                  label={$t('buildingModal.material')}
                  note={getBulkFieldNote('material')}
                >
                  <UiSelect
                    items={[{ value: '', label: $t('buildingModal.notSpecified') }, ...buildingMaterialItems]}
                    bind:value={form.material}
                    placeholder={getFieldPlaceholder('material')}
                    contentClassName="ui-floating-layer-building-modal"
                    onchange={() => markBulkFieldOverride('material')}
                  />
                </FormRow>

                <FormRow
                  forId="building-colour"
                  label={$t('buildingModal.colour')}
                  note={getBulkFieldNote('colour')}
                >
                  <BulkClearAction
                    show={selectionState.isBulkSelection && shouldShowBulkClearAction('colour', form.colour)}
                    ariaLabel={$t('buildingModal.bulkClearField')}
                    title={$t('buildingModal.bulkClearField')}
                    onclick={() => clearBulkField('colour')}
                  >
                    <div class="colour-picker-row">
                      <UiColorPicker
                        value={form.colour}
                        label={$t('buildingModal.colour')}
                        swatches={buildingColourSwatches}
                        contentClassName="ui-floating-layer-building-modal"
                        onchange={handleColourChange}
                      />
                      {#if !selectionState.isBulkSelection}
                        <UiButton
                          type="button"
                          variant="secondary"
                          size="xs"
                          disabled={!form.colour}
                          onclick={() => clearBulkField('colour')}
                        >
                          {$t('common.clear')}
                        </UiButton>
                      {/if}
                    </div>
                  </BulkClearAction>
                </FormRow>

                <FormRow
                  forId="building-archimap-description"
                  label={$t('buildingModal.extraInfo')}
                  note={getBulkFieldNote('archimapDescription')}
                >
                  <BulkClearAction
                    show={shouldShowBulkClearAction('archimapDescription', form.archimapDescription)}
                    ariaLabel={$t('buildingModal.bulkClearField')}
                    title={$t('buildingModal.bulkClearField')}
                    onclick={() => clearBulkField('archimapDescription')}
                  >
                    <UiTextarea
                      id="building-archimap-description"
                      rows="4"
                      bind:value={form.archimapDescription}
                      placeholder={getTextFieldPlaceholder('archimapDescription')}
                      oninput={() => markBulkFieldOverride('archimapDescription')}
                    ></UiTextarea>
                  </BulkClearAction>
                </FormRow>
              {/if}
            </section>

            {#if !selectionState.isBulkSelection && !selectionState.isPartEditMode}
              <section class="form-section">
                <div class="section-head">
                  <h4>{$t('buildingModal.addressSection')}</h4>
                </div>

                {#if canEditAddressFull}
                  <FormRow forId="building-addr-full" label={$t('buildingModal.addressFull')}>
                    <UiInput id="building-addr-full" type="text" bind:value={form.addressFull} />
                  </FormRow>
                {:else}
                  <FormRow note={$t('buildingModal.addressFullDerived')} />
                {/if}

                <div class="grid2">
                  <FormRow forId="building-addr-postcode" label={$t('buildingModal.postcode')}>
                    <UiInput id="building-addr-postcode" type="text" bind:value={form.addressPostcode} />
                  </FormRow>

                  <FormRow forId="building-addr-city" label={$t('buildingModal.city')}>
                    <UiInput id="building-addr-city" type="text" bind:value={form.addressCity} />
                  </FormRow>

                  <FormRow forId="building-addr-place" label={$t('buildingModal.place')}>
                    <UiInput id="building-addr-place" type="text" bind:value={form.addressPlace} />
                  </FormRow>

                  <FormRow forId="building-addr-street" label={$t('buildingModal.street')}>
                    <UiInput id="building-addr-street" type="text" bind:value={form.addressStreet} />
                  </FormRow>
                </div>

                <FormRow forId="building-addr-housenumber" label={$t('buildingModal.houseNumber')}>
                  <UiInput id="building-addr-housenumber" type="text" bind:value={form.addressHouseNumber} />
                </FormRow>
              </section>
            {/if}

            {#if !selectionState.isBulkSelection}
              <details class="osm-tags">
                <summary>{$t('buildingModal.osmTagsTitle')} ({osmTagEntries.length})</summary>
                {#if osmTagEntries.length > 0}
                  <UiScrollArea className="max-h-[18rem]" contentClassName="mt-[0.8rem] grid gap-[0.55rem] pr-[0.15rem]">
                    {#each osmTagEntries as item (item.key)}
                      <div class="osm-tag-row">
                        <code class="osm-tag-key">{item.key}</code>
                        <code class="osm-tag-value">{item.value || '-'}</code>
                      </div>
                    {/each}
                  </UiScrollArea>
                {:else}
                  <p class="osm-tags-empty">{$t('buildingModal.osmTagsEmpty')}</p>
                {/if}
              </details>
            {/if}

            <div class="form-footer">
              <datalist id="building-design-ref-suggestions">
                {#each designRefSuggestions as suggestion}
                  <option value={suggestion}></option>
                {/each}
              </datalist>
              <p class="status" data-filled={saveStatus ? 'true' : 'false'}>{saveStatus || ''}</p>
              <UiButton type="submit" disabled={savePending || !selectionState.hasEditableFields}>
                {savePending ? $t('buildingModal.saving') : $t('buildingModal.save')}
              </UiButton>
            </div>
          </form>
        {:else}
          {#if isAuthenticated}
            <p class="warning">{$t('buildingModal.editDenied')}</p>
          {/if}

          <section class="read-grid">
            {#if !selectionState.isBulkSelection}
              <article class="read-card">
                <span>{$t('buildingModal.osmKey')}</span>
                <strong>{buildingKey}</strong>
              </article>
            {/if}

            {#if !selectionState.isBulkSelection}
              <article class="read-card">
                <span>{$t('search.address')}</span>
                <strong>{formatDisplayText(displayAddress)}</strong>
              </article>
            {/if}

            {#each summaryItems as item}
              <article class="read-card">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </article>
            {/each}

            {#if displayDescription}
              <article class="read-card read-card-wide">
                <span>{$t('buildingModal.description')}</span>
                <strong>{formatDisplayText(displayDescription)}</strong>
              </article>
            {/if}
          </section>

          {#if !selectionState.isBulkSelection}
            <details class="osm-tags">
              <summary>{$t('buildingModal.osmTagsTitle')} ({osmTagEntries.length})</summary>
              {#if osmTagEntries.length > 0}
                <UiScrollArea className="max-h-[18rem]" contentClassName="mt-[0.8rem] grid gap-[0.55rem] pr-[0.15rem]">
                  {#each osmTagEntries as item (item.key)}
                    <div class="osm-tag-row">
                      <code class="osm-tag-key">{item.key}</code>
                      <code class="osm-tag-value">{item.value || '-'}</code>
                    </div>
                  {/each}
                </UiScrollArea>
              {:else}
                <p class="osm-tags-empty">{$t('buildingModal.osmTagsEmpty')}</p>
              {/if}
            </details>
          {/if}
        {/if}
      {:else}
        <p class="loading-state">{$t('buildingModal.loading')}</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    --building-modal-top-gap: calc(var(--desktop-nav-clearance) + 0.55rem);
    --building-modal-side-gap: 0.75rem;
    --building-modal-bottom-gap: calc(0.75rem + env(safe-area-inset-bottom, 0px));
    position: fixed;
    inset: 0;
    z-index: 990;
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    padding: var(--building-modal-top-gap) var(--building-modal-side-gap) var(--building-modal-bottom-gap);
    background: transparent;
    pointer-events: none;
  }

  .backdrop .modal {
    pointer-events: auto;
  }

  .modal {
    position: relative;
    z-index: 1;
    width: min(46vw, 54rem);
    max-width: calc(100vw - 1.5rem);
    height: calc(100vh - var(--building-modal-top-gap) - var(--building-modal-bottom-gap));
    height: calc(100dvh - var(--building-modal-top-gap) - var(--building-modal-bottom-gap));
    max-height: calc(100vh - var(--building-modal-top-gap) - var(--building-modal-bottom-gap));
    max-height: calc(100dvh - var(--building-modal-top-gap) - var(--building-modal-bottom-gap));
    overflow: auto;
    display: grid;
    align-content: start;
    gap: 1rem;
    padding: 1rem;
    border-radius: 1.4rem;
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
    box-shadow: var(--shadow-panel);
  }

  .modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .modal-header-copy {
    display: grid;
    gap: 0.35rem;
  }

  .modal-header h3 {
    margin: 0;
    font-size: 1.45rem;
    line-height: 1.1;
    color: var(--fg-strong);
  }

  .modal-header-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.55rem;
    align-items: center;
  }

  .modal-address {
    color: var(--muted);
    font-size: 0.88rem;
  }

  .overview-card,
  .form-section,
  .read-card {
    border: 1px solid var(--panel-border);
    border-radius: 1.15rem;
    background: var(--panel-solid);
    box-shadow: 0 12px 30px rgba(15, 23, 42, 0.06);
  }

  .overview-card {
    padding: 1rem;
    display: grid;
    gap: 0.95rem;
  }

  .overview-head {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: flex-start;
  }

  .overview-head h4 {
    margin: 0;
    font-size: 1rem;
    color: var(--fg-strong);
  }

  .overview-head p {
    margin: 0.3rem 0 0;
    color: var(--muted-strong);
    line-height: 1.55;
  }

  .overview-grid,
  .read-grid {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .overview-stat,
  .read-card {
    padding: 0.85rem 0.9rem;
  }

  .overview-stat span,
  .read-card span {
    display: block;
    font-size: 0.74rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-bottom: 0.38rem;
  }

  .overview-stat strong,
  .read-card strong {
    display: block;
    color: var(--fg-strong);
    font-size: 0.96rem;
    line-height: 1.4;
    word-break: break-word;
  }

  .read-card-wide {
    grid-column: 1 / -1;
  }

  .warning {
    margin: 0;
    padding: 0.9rem 1rem;
    border: 1px solid color-mix(in srgb, var(--ui-text-warning) 28%, var(--panel-border));
    border-radius: 1rem;
    background: var(--ui-surface-warning);
    color: var(--ui-text-warning-strong);
    font-size: 0.9rem;
    line-height: 1.45;
  }

  .bulk-selection-note {
    margin: 0;
    padding: 0.9rem 1rem;
    border: 1px solid color-mix(in srgb, var(--ui-text-info) 26%, var(--panel-border));
    border-radius: 1rem;
    background: var(--ui-surface-info);
    color: var(--ui-text-info);
    font-size: 0.9rem;
    line-height: 1.45;
  }

  .bulk-selection-note strong {
    font-weight: 700;
  }

  .edit-form {
    display: grid;
    gap: 1rem;
  }

  .form-section {
    padding: 1rem;
    display: grid;
    gap: 0.85rem;
  }

  .section-head {
    display: flex;
    align-items: flex-start;
    justify-content: flex-start;
    text-align: left;
  }

  .section-head h4 {
    margin: 0;
    font-size: 1rem;
    color: var(--fg-strong);
  }

  .grid2 {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .design-toggle-row {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
  }

  :global(.design-toggle-checkbox) {
    flex: 0 0 auto;
  }

  :global(.design-toggle-value-input) {
    flex: 1 1 12rem;
    min-width: 14rem;
  }

  .colour-picker-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }

  .form-footer {
    position: sticky;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.85rem 0 0;
    border-top: 1px solid var(--panel-border);
    background: var(--panel-solid);
  }

  .status {
    min-height: 1.25rem;
    margin: 0;
    color: var(--muted);
    font-size: 0.84rem;
    line-height: 1.35;
  }

  .status[data-filled='true'] {
    padding: 0.7rem 0.8rem;
    border-radius: 0.95rem;
    border: 1px solid var(--panel-border);
    background: var(--panel-solid);
  }

  .osm-tags {
    margin: 0;
    border: 1px solid var(--panel-border);
    border-radius: 1rem;
    background: var(--panel-solid);
    padding: 0.65rem 0.75rem;
  }

  .osm-tags > summary {
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--fg-strong);
    user-select: none;
  }

  .osm-tag-row {
    display: grid;
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
    gap: 0.6rem;
    align-items: start;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--panel-border);
    border-radius: 0.85rem;
    background: var(--panel-solid);
  }

  .osm-tag-key,
  .osm-tag-value {
    font-size: 0.74rem;
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .osm-tag-key {
    color: var(--accent-ink);
  }

  .osm-tag-value {
    color: var(--fg);
  }

  .osm-tags-empty,
  .loading-state {
    margin: 0;
    color: var(--muted);
    font-size: 0.88rem;
  }

  .loading-state {
    padding: 1rem;
    border: 1px dashed var(--panel-border-strong);
    border-radius: 1rem;
    background: var(--panel-solid);
  }

  @media (max-width: 1100px) {
    .modal {
      width: calc(100vw - 1.5rem);
      max-width: calc(100vw - 1.5rem);
    }
  }

  @media (max-width: 820px) {
    .backdrop {
      justify-content: stretch;
    }

    .modal {
      width: 100%;
      border-radius: 1.35rem;
    }

    .overview-grid,
    .read-grid,
    .grid2 {
      grid-template-columns: 1fr;
    }

    .overview-head,
    .form-footer {
      flex-direction: column;
      align-items: stretch;
    }
  }

  @media (min-width: 768px) {
    .backdrop {
      --building-modal-top-gap: calc(var(--desktop-nav-clearance) + var(--desktop-surface-gap));
      --building-modal-side-gap: 0.85rem;
      --building-modal-bottom-gap: 0.85rem;
    }
  }
</style>
