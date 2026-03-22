<script>
  import { createEventDispatcher, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { UiBadge, UiButton, UiColorPicker, UiInput, UiScrollArea, UiSelect, UiTextarea } from '$lib/components/base';
  import { buildingModalOpen } from '$lib/stores/ui';
  import { selectedBuilding } from '$lib/stores/map';
  import { locale, t } from '$lib/i18n/index';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import FormRow from '$lib/components/shell/FormRow.svelte';
  import { getArchitectureStyleOptions } from '$lib/utils/architecture-style';
  import { getBuildingMaterialOptions, toHumanBuildingMaterial } from '$lib/utils/building-material';
  import { styleRegionOverrides } from '$lib/stores/style-overrides';
  import {
    buildAddressFromBuildingForm,
    buildBuildingComparableSnapshot,
    createEmptyBuildingComparable,
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

  let lastBuildingKey = null;
  let form = createEmptyBuildingForm();
  let initialComparable = createEmptyBuildingComparable();
  let canEditAddressFull = true;
  let osmTagEntries = [];
  let modalEl = null;
  let hadOpenState;

  function hydrateForm(details) {
    const nextState = hydrateBuildingForm(details);
    form = nextState.form;
    initialComparable = nextState.initialComparable;
    canEditAddressFull = nextState.canEditAddressFull;
    osmTagEntries = nextState.osmTagEntries;
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

  $: currentComparable = buildComparableSnapshot(form);
  $: editedFields = getEditedFields(currentComparable, initialComparable);
  $: hasEditedFields = editedFields.length > 0;

  function submitEdit(event) {
    event.preventDefault();
    const selection = $selectedBuilding;
    if (!selection?.osmType || !selection?.osmId || !canEditBuildings || savePending) return;
    if (!hasEditedFields) return;
    const snapshot = currentComparable;
    dispatch('save', {
      osmType: selection.osmType,
      osmId: Number(selection.osmId),
      name: snapshot.name,
      style: snapshot.style,
      material: snapshot.material,
      colour: snapshot.colour,
      levels: snapshot.levels,
      yearBuilt: snapshot.yearBuilt,
      architect: snapshot.architect,
      address: snapshot.address,
      archimapDescription: snapshot.archimapDescription,
      editedFields
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

  $: if ($buildingModalOpen && $selectedBuilding?.osmType && $selectedBuilding?.osmId) {
    const key = `${$selectedBuilding.osmType}/${$selectedBuilding.osmId}`;
    if (key !== lastBuildingKey) {
      lastBuildingKey = key;
      hydrateForm(buildingDetails);
    }
  }

  $: if ($buildingModalOpen && buildingDetails && lastBuildingKey) {
    hydrateForm(buildingDetails);
  }

  $: if ($buildingModalOpen && !hadOpenState) {
    hadOpenState = true;
    tick().then(() => modalEl?.focus());
  } else if (!$buildingModalOpen && hadOpenState) {
    hadOpenState = false;
  }
  $: void hadOpenState;

  $: archiInfo = buildingDetails?.properties?.archiInfo || {};
  $: isBuildingPartFeature = buildingDetails?.feature_kind === 'building_part';
  $: buildingKey = $selectedBuilding?.osmType && $selectedBuilding?.osmId
    ? `${$selectedBuilding.osmType}/${$selectedBuilding.osmId}`
    : '-';
  $: displayName = pickFirstText(form.name, archiInfo.name) || buildingKey;
  $: displayAddress = pickFirstText(buildAddressFromForm(), archiInfo.address);
  $: displayStyle = resolveDisplayStyle(form.style || archiInfo.styleRaw || archiInfo.style, $locale);
  $: displayMaterialRaw = pickFirstText(form.material, archiInfo.material);
  $: displayMaterial = displayMaterialRaw
    ? (toHumanBuildingMaterial(displayMaterialRaw, $locale) || displayMaterialRaw)
    : '';
  $: displayColour = pickFirstText(form.colour, archiInfo.colour);
  $: displayDescription = pickFirstText(form.archimapDescription, archiInfo.archimap_description, archiInfo.description);
  $: currentRegionSlugs = Array.isArray(buildingDetails?.region_slugs) ? buildingDetails.region_slugs : [];
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
  $: summaryItems = [
    { label: $t('buildingModal.style'), value: displayStyle },
    { label: $t('buildingModal.material'), value: displayMaterial },
    { label: $t('buildingModal.colour'), value: displayColour },
    { label: $t('buildingModal.levels'), value: pickFirstText(form.levels, archiInfo.levels) },
    { label: $t('buildingModal.yearBuilt'), value: pickFirstText(form.yearBuilt, archiInfo.year_built) },
    { label: $t('buildingModal.architect'), value: pickFirstText(form.architect, archiInfo.architect) }
  ].filter((item) => pickFirstText(item.value) && item.value !== '-');
</script>

{#if $buildingModalOpen}
  <div
    class="backdrop"
    in:fade={{ duration: 160 }}
    out:fade={{ duration: 150 }}
  >
    <button
      type="button"
      class="backdrop-dismiss-layer"
      tabindex="-1"
      aria-label={$t('common.close')}
      on:click={closeModal}
    ></button>

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
            <UiBadge
              variant="accent"
              className="inline-flex items-center rounded-full px-[0.72rem] py-[0.42rem] text-[0.78rem] font-bold [background:var(--accent-soft)] [color:var(--accent-ink)]"
            >
              {buildingKey}
            </UiBadge>
            {#if displayAddress}
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

      {#if buildingDetails}
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

        {#if canEditBuildings}
          <form class="edit-form" on:submit={submitEdit}>
            <section class="form-section">
              <div class="section-head">
                <h4>{$t('buildingModal.primarySection')}</h4>
              </div>

              {#if isBuildingPartFeature}
                <div class="grid2">
                  <FormRow forId="building-levels" label={$t('buildingModal.levels')}>
                    <UiInput id="building-levels" type="number" min="0" max="300" bind:value={form.levels} />
                  </FormRow>

                  <FormRow forId="building-year" label={$t('buildingModal.yearBuilt')}>
                    <UiInput id="building-year" type="number" min="1000" max="2100" bind:value={form.yearBuilt} />
                  </FormRow>
                </div>

                <FormRow forId="building-style-select" label={$t('buildingModal.style')}>
                  <UiSelect
                    items={[{ value: '', label: $t('buildingModal.notSpecified') }, ...architectureStyleItems]}
                    bind:value={form.style}
                    placeholder={$t('buildingModal.notSpecified')}
                    contentClassName="ui-floating-layer-building-modal"
                  />
                </FormRow>

                <FormRow forId="building-material-select" label={$t('buildingModal.material')}>
                  <UiSelect
                    items={[{ value: '', label: $t('buildingModal.notSpecified') }, ...buildingMaterialItems]}
                    bind:value={form.material}
                    placeholder={$t('buildingModal.notSpecified')}
                    contentClassName="ui-floating-layer-building-modal"
                  />
                </FormRow>

                <FormRow forId="building-colour" label={$t('buildingModal.colour')}>
                  <div class="colour-picker-row">
                    <UiColorPicker
                      value={form.colour}
                      label={$t('buildingModal.colour')}
                      swatches={buildingColourSwatches}
                      contentClassName="ui-floating-layer-building-modal"
                      onchange={(event) => (form.colour = String(event?.detail?.value || ''))}
                    />
                    <UiButton
                      type="button"
                      variant="secondary"
                      size="xs"
                      disabled={!form.colour}
                      onclick={() => (form.colour = '')}
                    >
                      {$t('common.clear')}
                    </UiButton>
                  </div>
                </FormRow>
              {:else}
                <FormRow forId="building-name" label={$t('buildingModal.name')}>
                  <UiInput id="building-name" type="text" bind:value={form.name} />
                </FormRow>

                <div class="grid2">
                  <FormRow forId="building-levels" label={$t('buildingModal.levels')}>
                    <UiInput id="building-levels" type="number" min="0" max="300" bind:value={form.levels} />
                  </FormRow>

                  <FormRow forId="building-year" label={$t('buildingModal.yearBuilt')}>
                    <UiInput id="building-year" type="number" min="1000" max="2100" bind:value={form.yearBuilt} />
                  </FormRow>
                </div>

                <FormRow forId="building-architect" label={$t('buildingModal.architect')}>
                  <UiInput id="building-architect" type="text" bind:value={form.architect} />
                </FormRow>

                <FormRow forId="building-style-select" label={$t('buildingModal.style')}>
                  <UiSelect
                    items={[{ value: '', label: $t('buildingModal.notSpecified') }, ...architectureStyleItems]}
                    bind:value={form.style}
                    placeholder={$t('buildingModal.notSpecified')}
                    contentClassName="ui-floating-layer-building-modal"
                  />
                </FormRow>

                <FormRow forId="building-material-select" label={$t('buildingModal.material')}>
                  <UiSelect
                    items={[{ value: '', label: $t('buildingModal.notSpecified') }, ...buildingMaterialItems]}
                    bind:value={form.material}
                    placeholder={$t('buildingModal.notSpecified')}
                    contentClassName="ui-floating-layer-building-modal"
                  />
                </FormRow>

                <FormRow forId="building-colour" label={$t('buildingModal.colour')}>
                  <div class="colour-picker-row">
                    <UiColorPicker
                      value={form.colour}
                      label={$t('buildingModal.colour')}
                      swatches={buildingColourSwatches}
                      contentClassName="ui-floating-layer-building-modal"
                      onchange={(event) => (form.colour = String(event?.detail?.value || ''))}
                    />
                    <UiButton
                      type="button"
                      variant="secondary"
                      size="xs"
                      disabled={!form.colour}
                      onclick={() => (form.colour = '')}
                    >
                      {$t('common.clear')}
                    </UiButton>
                  </div>
                </FormRow>

                <FormRow forId="building-archimap-description" label={$t('buildingModal.extraInfo')}>
                  <UiTextarea id="building-archimap-description" rows="4" bind:value={form.archimapDescription}></UiTextarea>
                </FormRow>
              {/if}
            </section>

            {#if !isBuildingPartFeature}
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

            <div class="form-footer">
              <p class="status" data-filled={saveStatus ? 'true' : 'false'}>{saveStatus || ''}</p>
              <UiButton type="submit" disabled={savePending || !hasEditedFields}>
                {savePending ? $t('buildingModal.saving') : $t('buildingModal.save')}
              </UiButton>
            </div>
          </form>
        {:else}
          {#if isAuthenticated}
            <p class="warning">{$t('buildingModal.editDenied')}</p>
          {/if}

          <section class="read-grid">
            <article class="read-card">
              <span>{$t('buildingModal.osmKey')}</span>
              <strong>{buildingKey}</strong>
            </article>

            <article class="read-card">
              <span>{$t('search.address')}</span>
              <strong>{formatDisplayText(displayAddress)}</strong>
            </article>

            {#each summaryItems as item}
              <article class="read-card">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </article>
            {/each}

            <article class="read-card read-card-wide">
              <span>{$t('buildingModal.description')}</span>
              <strong>{formatDisplayText(displayDescription)}</strong>
            </article>
          </section>

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
  }

  .backdrop-dismiss-layer {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: transparent;
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
    background: color-mix(in srgb, var(--panel-solid) 96%, transparent);
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
    background: color-mix(in srgb, var(--panel-solid) 82%, transparent);
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
    border: 1px solid color-mix(in srgb, #f59e0b 42%, var(--panel-border));
    border-radius: 1rem;
    background: rgba(245, 158, 11, 0.12);
    color: #9a3412;
    font-size: 0.9rem;
    line-height: 1.45;
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
    background: linear-gradient(180deg, rgba(255, 255, 255, 0) 0%, color-mix(in srgb, var(--panel-solid) 92%, transparent) 42%);
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
    background: color-mix(in srgb, var(--panel-solid) 82%, transparent);
  }

  .osm-tags {
    margin: 0;
    border: 1px solid var(--panel-border);
    border-radius: 1rem;
    background: color-mix(in srgb, var(--panel-solid) 76%, transparent);
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
    background: color-mix(in srgb, var(--panel-solid) 84%, transparent);
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
    background: color-mix(in srgb, var(--panel-solid) 74%, transparent);
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
