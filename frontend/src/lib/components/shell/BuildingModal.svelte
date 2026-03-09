<script>
  import { createEventDispatcher, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { buildingModalOpen } from '$lib/stores/ui';
  import { selectedBuilding } from '$lib/stores/map';
  import { locale, t } from '$lib/i18n/index';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import {
    getArchitectureStyleOptions,
    normalizeArchitectureStyleKey,
    toHumanArchitectureStyle
  } from '$lib/utils/architecture-style';
  import { buildAddressText, hasStructuredAddressParts, parseAddressFields } from '$lib/utils/building-address';
  import {
    formatDisplayText,
    normalizeIntegerField,
    pickFirstText
  } from '$lib/utils/text';

  export let buildingDetails = null;
  export let isAuthenticated = false;
  export let canEditBuildings = false;
  export let savePending = false;
  export let saveStatus = '';

  const dispatch = createEventDispatcher();

  let lastBuildingKey = null;
  let form = createEmptyForm();
  let initialComparable = createEmptyComparable();
  let canEditAddressFull = true;
  let sourceTags = {};
  let osmTagEntries = [];
  let modalEl = null;
  let hadOpenState = false;
  function createEmptyForm() {
    return {
      name: '',
      levels: '',
      yearBuilt: '',
      architect: '',
      style: '',
      archimapDescription: '',
      addressFull: '',
      addressPostcode: '',
      addressCity: '',
      addressPlace: '',
      addressStreet: '',
      addressHouseNumber: ''
    };
  }

  function createEmptyComparable() {
    return {
      name: '',
      levels: '',
      yearBuilt: '',
      architect: '',
      style: '',
      archimapDescription: '',
      address: ''
    };
  }

  function normalizeStyleForForm(value) {
    const raw = pickFirstText(value).split(';')[0];
    return normalizeArchitectureStyleKey(raw);
  }

  function hydrateForm(details) {
    const info = details?.properties?.archiInfo || {};
    sourceTags = info?._sourceTags && typeof info._sourceTags === 'object' ? info._sourceTags : {};
    const hasExplicitFullAddress = Boolean(pickFirstText(sourceTags?.['addr:full'], sourceTags?.addr_full));
    const addressPartsPresent = hasStructuredAddressParts(sourceTags, pickFirstText);
    canEditAddressFull = hasExplicitFullAddress || !addressPartsPresent;
    const fallbackAddress = pickFirstText(info.address, sourceTags?.['addr:full'], sourceTags?.addr_full);
    const nextAddressFields = parseAddressFields(sourceTags, pickFirstText, {
      fallbackAddress,
      allowAddressRawAsFull: canEditAddressFull
    });
    const nextForm = {
      name: pickFirstText(info.name, sourceTags?.name, sourceTags?.['name:ru'], sourceTags?.['name:en']),
      levels: normalizeIntegerField(info.levels ?? sourceTags?.['building:levels'] ?? sourceTags?.levels, 0, 300),
      yearBuilt: normalizeIntegerField(
        info.year_built ?? sourceTags?.['building:year'] ?? sourceTags?.year_built ?? sourceTags?.start_date,
        1000,
        2100
      ),
      architect: pickFirstText(info.architect, sourceTags?.architect, sourceTags?.architect_name),
      style: normalizeStyleForForm(info.styleRaw ?? info.style ?? sourceTags?.['building:architecture'] ?? sourceTags?.architecture ?? sourceTags?.style),
      archimapDescription: pickFirstText(info.archimap_description, info.description),
      addressFull: nextAddressFields.full,
      addressPostcode: nextAddressFields.postcode,
      addressCity: nextAddressFields.city,
      addressPlace: nextAddressFields.place,
      addressStreet: nextAddressFields.street,
      addressHouseNumber: nextAddressFields.housenumber
    };
    form = nextForm;
    initialComparable = buildComparableSnapshot(nextForm);
    osmTagEntries = Object.entries(sourceTags)
      .map(([key, value]) => ({
        key: String(key || '').trim(),
        value: value == null
          ? ''
          : (typeof value === 'object' ? JSON.stringify(value) : String(value))
      }))
      .filter((item) => item.key.length > 0)
      .sort((a, b) => a.key.localeCompare(b.key, 'en'));
  }

  function buildAddressFromForm(formValue = form) {
    return buildAddressText({
      full: formValue.addressFull,
      postcode: formValue.addressPostcode,
      city: formValue.addressCity,
      place: formValue.addressPlace,
      street: formValue.addressStreet,
      housenumber: formValue.addressHouseNumber
    }, pickFirstText);
  }

  function buildComparableSnapshot(formValue = form) {
    return {
      name: pickFirstText(formValue.name),
      style: normalizeArchitectureStyleKey(formValue.style),
      levels: pickFirstText(formValue.levels),
      yearBuilt: pickFirstText(formValue.yearBuilt),
      architect: pickFirstText(formValue.architect),
      address: buildAddressFromForm(formValue),
      archimapDescription: pickFirstText(formValue.archimapDescription)
    };
  }

  function getEditedFields(currentSnapshot, initialSnapshot) {
    return Object.keys(currentSnapshot).filter((key) => currentSnapshot[key] !== (initialSnapshot?.[key] || ''));
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
    const raw = pickFirstText(value);
    if (!raw) return '';
    return toHumanArchitectureStyle(raw, localeValue) || raw;
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

  $: archiInfo = buildingDetails?.properties?.archiInfo || {};
  $: buildingKey = $selectedBuilding?.osmType && $selectedBuilding?.osmId
    ? `${$selectedBuilding.osmType}/${$selectedBuilding.osmId}`
    : '-';
  $: displayName = pickFirstText(form.name, archiInfo.name) || buildingKey;
  $: displayAddress = pickFirstText(buildAddressFromForm(), archiInfo.address);
  $: displayStyle = resolveDisplayStyle(form.style || archiInfo.styleRaw || archiInfo.style, $locale);
  $: displayDescription = pickFirstText(form.archimapDescription, archiInfo.archimap_description, archiInfo.description);
  $: summaryItems = [
    { label: $t('buildingModal.style'), value: displayStyle },
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
            <span class="identity-pill">{buildingKey}</span>
            {#if displayAddress}
              <span class="modal-address">{displayAddress}</span>
            {/if}
          </div>
        </div>

        <button
          type="button"
          class="ui-btn ui-btn-secondary ui-btn-xs ui-btn-close"
          on:click={closeModal}
          aria-label={$t('common.close')}
        >
          <CloseIcon class="ui-close-icon" />
        </button>
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

              <div class="row">
                <label for="building-name">{$t('buildingModal.name')}</label>
                <input id="building-name" class="ui-field" type="text" bind:value={form.name} />
              </div>

              <div class="grid2">
                <div class="row">
                  <label for="building-levels">{$t('buildingModal.levels')}</label>
                  <input id="building-levels" class="ui-field" type="number" min="0" max="300" bind:value={form.levels} />
                </div>

                <div class="row">
                  <label for="building-year">{$t('buildingModal.yearBuilt')}</label>
                  <input id="building-year" class="ui-field" type="number" min="1000" max="2100" bind:value={form.yearBuilt} />
                </div>
              </div>

              <div class="row">
                <label for="building-architect">{$t('buildingModal.architect')}</label>
                <input id="building-architect" class="ui-field" type="text" bind:value={form.architect} />
              </div>

              <div class="row">
                <label for="building-style-select">{$t('buildingModal.style')}</label>
                <select id="building-style-select" class="ui-field" bind:value={form.style}>
                  <option value="">{$t('buildingModal.notSpecified')}</option>
                  {#each getArchitectureStyleOptions($locale) as option}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              </div>

              <div class="row">
                <label for="building-archimap-description">{$t('buildingModal.extraInfo')}</label>
                <textarea id="building-archimap-description" class="ui-field" rows="4" bind:value={form.archimapDescription}></textarea>
              </div>
            </section>

            <section class="form-section">
              <div class="section-head">
                <h4>{$t('buildingModal.addressSection')}</h4>
              </div>

              {#if canEditAddressFull}
                <div class="row">
                  <label for="building-addr-full">{$t('buildingModal.addressFull')}</label>
                  <input id="building-addr-full" class="ui-field" type="text" bind:value={form.addressFull} />
                </div>
              {:else}
                <p class="field-note">{$t('buildingModal.addressFullDerived')}</p>
              {/if}

              <div class="grid2">
                <div class="row">
                  <label for="building-addr-postcode">{$t('buildingModal.postcode')}</label>
                  <input id="building-addr-postcode" class="ui-field" type="text" bind:value={form.addressPostcode} />
                </div>

                <div class="row">
                  <label for="building-addr-city">{$t('buildingModal.city')}</label>
                  <input id="building-addr-city" class="ui-field" type="text" bind:value={form.addressCity} />
                </div>

                <div class="row">
                  <label for="building-addr-place">{$t('buildingModal.place')}</label>
                  <input id="building-addr-place" class="ui-field" type="text" bind:value={form.addressPlace} />
                </div>

                <div class="row">
                  <label for="building-addr-street">{$t('buildingModal.street')}</label>
                  <input id="building-addr-street" class="ui-field" type="text" bind:value={form.addressStreet} />
                </div>
              </div>

              <div class="row">
                <label for="building-addr-housenumber">{$t('buildingModal.houseNumber')}</label>
                <input id="building-addr-housenumber" class="ui-field" type="text" bind:value={form.addressHouseNumber} />
              </div>
            </section>

            <details class="osm-tags">
              <summary>{$t('buildingModal.osmTagsTitle')} ({osmTagEntries.length})</summary>
              {#if osmTagEntries.length > 0}
                <div class="osm-tags-list">
                  {#each osmTagEntries as item (item.key)}
                    <div class="osm-tag-row">
                      <code class="osm-tag-key">{item.key}</code>
                      <code class="osm-tag-value">{item.value || '-'}</code>
                    </div>
                  {/each}
                </div>
              {:else}
                <p class="osm-tags-empty">{$t('buildingModal.osmTagsEmpty')}</p>
              {/if}
            </details>

            <div class="form-footer">
              <p class="status" data-filled={saveStatus ? 'true' : 'false'}>{saveStatus || ''}</p>
              <button type="submit" class="ui-btn ui-btn-primary" disabled={savePending || !hasEditedFields}>
                {savePending ? $t('buildingModal.saving') : $t('buildingModal.save')}
              </button>
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
              <div class="osm-tags-list">
                {#each osmTagEntries as item (item.key)}
                  <div class="osm-tag-row">
                    <code class="osm-tag-key">{item.key}</code>
                    <code class="osm-tag-value">{item.value || '-'}</code>
                  </div>
                {/each}
              </div>
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

  .identity-pill {
    display: inline-flex;
    align-items: center;
    padding: 0.42rem 0.72rem;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 0.78rem;
    font-weight: 700;
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

  .row {
    display: grid;
    gap: 0.38rem;
  }

  .row > label {
    font-size: 0.76rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .field-note {
    margin: -0.15rem 0 0.1rem;
    color: var(--muted);
    font-size: 0.84rem;
    line-height: 1.45;
  }

  .grid2 {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(2, minmax(0, 1fr));
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

  .osm-tags-list {
    margin-top: 0.8rem;
    display: grid;
    gap: 0.55rem;
    max-height: 18rem;
    overflow: auto;
    padding-right: 0.15rem;
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
