<script>
  import { createEventDispatcher } from 'svelte';
  import { buildingModalOpen, closeBuildingModal } from '$lib/stores/ui';
  import { selectedBuilding, setSelectedBuilding } from '$lib/stores/map';
  import { UI_STRINGS } from '$lib/i18n/ui-strings';
  import {
    ARCHITECTURE_STYLE_OPTIONS_RU,
    normalizeArchitectureStyleKey,
    toHumanArchitectureStyle
  } from '$lib/utils/architecture-style';

  export let buildingDetails = null;
  export let isAuthenticated = false;
  export let canEditBuildings = false;
  export let savePending = false;
  export let saveStatus = '';

  const dispatch = createEventDispatcher();

  let lastBuildingKey = null;
  let form = createEmptyForm();

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

  function pickFirstText(...values) {
    for (const value of values) {
      if (value == null) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return '';
  }

  function parseAddressToFields(addressRaw, sourceTags) {
    const full = pickFirstText(
      sourceTags?.['addr:full'],
      sourceTags?.addr_full,
      addressRaw
    );
    return {
      full,
      postcode: pickFirstText(sourceTags?.['addr:postcode'], sourceTags?.addr_postcode),
      city: pickFirstText(sourceTags?.['addr:city'], sourceTags?.addr_city),
      place: pickFirstText(sourceTags?.['addr:place'], sourceTags?.addr_place),
      street: pickFirstText(sourceTags?.['addr:street'], sourceTags?.addr_street, sourceTags?.addr_stree),
      housenumber: pickFirstText(sourceTags?.['addr:housenumber'], sourceTags?.addr_housenumber, sourceTags?.addr_hous)
    };
  }

  function normalizeYear(value) {
    if (value == null) return '';
    const text = String(value).trim();
    return text || '';
  }

  function normalizeStyleForForm(value) {
    const raw = pickFirstText(value).split(';')[0];
    return normalizeArchitectureStyleKey(raw);
  }

  function hydrateForm(details) {
    const info = details?.properties?.archiInfo || {};
    const sourceTags = info?._sourceTags || {};
    const addressFields = parseAddressToFields(
      info.address ?? sourceTags?.['addr:full'] ?? sourceTags?.addr_full,
      sourceTags
    );
    form = {
      name: pickFirstText(info.name, sourceTags?.name, sourceTags?.['name:ru'], sourceTags?.['name:en']),
      levels: normalizeYear(info.levels ?? sourceTags?.['building:levels'] ?? sourceTags?.levels),
      yearBuilt: normalizeYear(info.year_built ?? sourceTags?.['building:year'] ?? sourceTags?.year_built ?? sourceTags?.start_date),
      architect: pickFirstText(info.architect, sourceTags?.architect, sourceTags?.architect_name),
      style: normalizeStyleForForm(info.styleRaw ?? info.style ?? sourceTags?.['building:architecture'] ?? sourceTags?.architecture ?? sourceTags?.style),
      archimapDescription: pickFirstText(info.archimap_description, info.description),
      addressFull: addressFields.full,
      addressPostcode: addressFields.postcode,
      addressCity: addressFields.city,
      addressPlace: addressFields.place,
      addressStreet: addressFields.street,
      addressHouseNumber: addressFields.housenumber
    };
  }

  function buildAddressFromForm() {
    const full = pickFirstText(form.addressFull);
    if (full) return full;
    const parts = [
      pickFirstText(form.addressPostcode),
      pickFirstText(form.addressCity),
      pickFirstText(form.addressPlace),
      pickFirstText(form.addressStreet)
    ].filter(Boolean);
    const house = pickFirstText(form.addressHouseNumber);
    if (house) {
      if (parts.length > 0) {
        parts[parts.length - 1] = `${parts[parts.length - 1]}, ${house}`;
      } else {
        parts.push(house);
      }
    }
    return parts.join(', ');
  }

  function submitEdit(event) {
    event.preventDefault();
    const selection = $selectedBuilding;
    if (!selection?.osmType || !selection?.osmId || !canEditBuildings || savePending) return;
    dispatch('save', {
      osmType: selection.osmType,
      osmId: Number(selection.osmId),
      name: pickFirstText(form.name),
      style: normalizeArchitectureStyleKey(form.style),
      levels: pickFirstText(form.levels),
      yearBuilt: pickFirstText(form.yearBuilt),
      architect: pickFirstText(form.architect),
      address: buildAddressFromForm(),
      archimapDescription: pickFirstText(form.archimapDescription)
    });
  }

  function closeOnBackdrop(event) {
    if (event.target === event.currentTarget) {
      setSelectedBuilding(null);
      closeBuildingModal();
    }
  }

  function closeOnKeydown(event) {
    if (event.key === 'Escape') {
      setSelectedBuilding(null);
      closeBuildingModal();
    }
  }

  function closeModal() {
    setSelectedBuilding(null);
    closeBuildingModal();
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
</script>

{#if $buildingModalOpen}
  <div
    class="backdrop"
    role="button"
    tabindex="0"
    on:click={closeOnBackdrop}
    on:keydown={closeOnKeydown}
  >
    <section id="building-modal" class="modal">
      <header>
        <h3>{UI_STRINGS.buildingModal.title}</h3>
        <button type="button" class="close ui-btn ui-btn-secondary ui-btn-xs" on:click={closeModal}>×</button>
      </header>
      {#if buildingDetails}
        {#if canEditBuildings}
          <form class="edit-form" on:submit={submitEdit}>
            <div class="row">
              <label for="building-name">{UI_STRINGS.buildingModal.name}</label>
              <input id="building-name" class="ui-field" type="text" bind:value={form.name} />
            </div>
            <div class="grid2">
              <div class="row">
                <label for="building-levels">{UI_STRINGS.buildingModal.levels}</label>
                <input id="building-levels" class="ui-field" type="number" min="0" max="300" bind:value={form.levels} />
              </div>
              <div class="row">
                <label for="building-year">{UI_STRINGS.buildingModal.yearBuilt}</label>
                <input id="building-year" class="ui-field" type="number" min="1000" max="2100" bind:value={form.yearBuilt} />
              </div>
            </div>
            <div class="row">
              <label for="building-architect">{UI_STRINGS.buildingModal.architect}</label>
              <input id="building-architect" class="ui-field" type="text" bind:value={form.architect} />
            </div>
            <div class="row">
              <label for="building-style-select">{UI_STRINGS.buildingModal.style}</label>
              <select id="building-style-select" class="ui-field" bind:value={form.style}>
                <option value="">{UI_STRINGS.buildingModal.notSpecified}</option>
                {#each ARCHITECTURE_STYLE_OPTIONS_RU as option}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </div>
            <div class="row">
              <label for="building-archimap-description">{UI_STRINGS.buildingModal.extraInfo}</label>
              <textarea id="building-archimap-description" class="ui-field" rows="3" bind:value={form.archimapDescription}></textarea>
            </div>
            <div class="row">
              <label for="building-addr-full">{UI_STRINGS.buildingModal.addressFull}</label>
              <input id="building-addr-full" class="ui-field" type="text" bind:value={form.addressFull} />
            </div>
            <div class="grid2">
              <div class="row">
                <label for="building-addr-postcode">{UI_STRINGS.buildingModal.postcode}</label>
                <input id="building-addr-postcode" class="ui-field" type="text" bind:value={form.addressPostcode} />
              </div>
              <div class="row">
                <label for="building-addr-city">{UI_STRINGS.buildingModal.city}</label>
                <input id="building-addr-city" class="ui-field" type="text" bind:value={form.addressCity} />
              </div>
              <div class="row">
                <label for="building-addr-place">{UI_STRINGS.buildingModal.place}</label>
                <input id="building-addr-place" class="ui-field" type="text" bind:value={form.addressPlace} />
              </div>
              <div class="row">
                <label for="building-addr-street">{UI_STRINGS.buildingModal.street}</label>
                <input id="building-addr-street" class="ui-field" type="text" bind:value={form.addressStreet} />
              </div>
            </div>
            <div class="row">
              <label for="building-addr-housenumber">{UI_STRINGS.buildingModal.houseNumber}</label>
              <input id="building-addr-housenumber" class="ui-field" type="text" bind:value={form.addressHouseNumber} />
            </div>
            <div class="form-footer">
              <p class="status">{saveStatus || ''}</p>
              <button type="submit" class="ui-btn ui-btn-primary" disabled={savePending}>
                {savePending ? UI_STRINGS.buildingModal.saving : UI_STRINGS.buildingModal.save}
              </button>
            </div>
          </form>
        {:else}
          {#if isAuthenticated}
            <p class="warning">{UI_STRINGS.buildingModal.editDenied}</p>
          {/if}
          <dl>
            <div>
              <dt>OSM key</dt>
              <dd>{$selectedBuilding?.osmType}/{$selectedBuilding?.osmId}</dd>
            </div>
            <div>
              <dt>{UI_STRINGS.buildingModal.name}</dt>
              <dd>{buildingDetails?.properties?.archiInfo?.name || '-'}</dd>
            </div>
            <div>
              <dt>{UI_STRINGS.buildingModal.levels}</dt>
              <dd>{buildingDetails?.properties?.archiInfo?.levels || '-'}</dd>
            </div>
            <div>
              <dt>{UI_STRINGS.buildingModal.yearBuilt}</dt>
              <dd>{buildingDetails?.properties?.archiInfo?.year_built || '-'}</dd>
            </div>
            <div>
              <dt>{UI_STRINGS.buildingModal.style}</dt>
              <dd>{toHumanArchitectureStyle(buildingDetails?.properties?.archiInfo?.styleRaw || buildingDetails?.properties?.archiInfo?.style) || buildingDetails?.properties?.archiInfo?.style || '-'}</dd>
            </div>
            <div>
              <dt>{UI_STRINGS.buildingModal.architect}</dt>
              <dd>{buildingDetails?.properties?.archiInfo?.architect || '-'}</dd>
            </div>
            <div>
              <dt>{UI_STRINGS.search.address}</dt>
              <dd>{buildingDetails?.properties?.archiInfo?.address || '-'}</dd>
            </div>
            <div>
              <dt>{UI_STRINGS.buildingModal.description}</dt>
              <dd>{buildingDetails?.properties?.archiInfo?.archimap_description || buildingDetails?.properties?.archiInfo?.description || '-'}</dd>
            </div>
          </dl>
        {/if}
      {:else}
        <p class="status">{UI_STRINGS.buildingModal.loading}</p>
      {/if}
    </section>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    pointer-events: none;
  }

  .modal {
    pointer-events: auto;
    position: absolute;
    top: 5.25rem;
    right: 0.75rem;
    bottom: 0.75rem;
    left: auto;
    width: min(46%, 52rem);
    max-height: calc(100vh - 6rem);
    overflow: auto;
    border-radius: 1rem;
    border: 1px solid #e2e8f0;
    background: #ffffff;
    padding: 0.9rem;
    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.12);
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
  }

  .close {
    cursor: pointer;
  }

  dl {
    margin: 0;
    display: grid;
    gap: 10px;
  }

  dt {
    font-size: 12px;
    text-transform: uppercase;
    color: #64748b;
    margin-bottom: 4px;
  }

  dd {
    margin: 0;
    padding: 10px;
    border: 1px solid #e2e8f0;
    border-radius: 0.75rem;
    background: #f8fafc;
    word-break: break-word;
  }

  .status {
    color: #64748b;
    margin: 0;
  }

  .warning {
    margin: 0 0 12px 0;
    padding: 10px;
    border: 1px solid #fcd34d;
    border-radius: 0.75rem;
    background: #fffbeb;
    color: #92400e;
    font-size: 14px;
  }

  .edit-form {
    display: grid;
    gap: 10px;
  }

  .row {
    display: grid;
    gap: 4px;
  }

  .row > label {
    font-size: 12px;
    text-transform: uppercase;
    color: #64748b;
  }

  .grid2 {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .form-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0 0 0;
  }

  :global(html[data-theme='dark']) .modal {
    border-color: #334155;
    background: #111a2d;
    box-shadow: 0 20px 40px rgba(2, 6, 23, 0.62);
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) dt {
    color: #94a3b8;
  }

  :global(html[data-theme='dark']) dd {
    border-color: #334155;
    background: #0f172a;
    color: #e2e8f0;
  }

  :global(html[data-theme='dark']) .status {
    color: #94a3b8;
  }

  :global(html[data-theme='dark']) .warning {
    border-color: #92400e;
    background: rgba(146, 64, 14, 0.15);
    color: #fde68a;
  }

  :global(html[data-theme='dark']) .row > label {
    color: #94a3b8;
  }

  @media (max-width: 1024px) {
    .modal {
      width: calc(100% - 1.5rem);
      top: 5.25rem;
      right: 0.75rem;
      left: 0.75rem;
      bottom: 0.75rem;
      max-height: calc(100vh - 6rem);
    }

    .grid2 {
      grid-template-columns: 1fr;
    }
  }
</style>
