import {
  normalizeArchitectureStyleKey,
  toHumanArchitectureStyle
} from './architecture-style.js';
import {
  normalizeBuildingMaterialSelection,
  splitBuildingMaterialSelection
} from './building-material.js';
import { buildAddressText, hasStructuredAddressParts, parseAddressFields } from './building-address.js';
import { normalizeIntegerField, pickFirstText } from './text.js';

export function createEmptyBuildingForm() {
  return {
    name: '',
    levels: '',
    yearBuilt: '',
    designYear: '',
    architect: '',
    style: '',
    design: '',
    designRef: '',
    material: '',
    colour: '',
    archimapDescription: '',
    addressFull: '',
    addressPostcode: '',
    addressCity: '',
    addressPlace: '',
    addressStreet: '',
    addressHouseNumber: ''
  };
}

export function createEmptyBuildingComparable() {
  return {
    name: '',
    levels: '',
    yearBuilt: '',
    designYear: '',
    architect: '',
    style: '',
    design: '',
    designRef: '',
    material: '',
    colour: '',
    archimapDescription: '',
    address: ''
  };
}

export function createEmptyBulkBuildingFieldState() {
  return {
    name: { isMixed: false, sampleValues: [], initialValue: '' },
    style: { isMixed: false, sampleValues: [], initialValue: '' },
    design: { isMixed: false, sampleValues: [], initialValue: '' },
    designRef: { isMixed: false, sampleValues: [], initialValue: '' },
    designYear: { isMixed: false, sampleValues: [], initialValue: '' },
    material: { isMixed: false, sampleValues: [], initialValue: '' },
    colour: { isMixed: false, sampleValues: [], initialValue: '' },
    levels: { isMixed: false, sampleValues: [], initialValue: '' },
    yearBuilt: { isMixed: false, sampleValues: [], initialValue: '' },
    architect: { isMixed: false, sampleValues: [], initialValue: '' },
    address: { isMixed: false, sampleValues: [], initialValue: '' },
    archimapDescription: { isMixed: false, sampleValues: [], initialValue: '' }
  };
}

const BULK_FIELD_FORM_MAP = Object.freeze({
  name: ['name'],
  style: ['style'],
  design: ['design'],
  designRef: ['designRef'],
  designYear: ['designYear'],
  material: ['material'],
  colour: ['colour'],
  levels: ['levels'],
  yearBuilt: ['yearBuilt'],
  architect: ['architect'],
  archimapDescription: ['archimapDescription']
});

function dedupeComparableValues(values = []) {
  const unique = [];
  const seen = new Set();
  for (const rawValue of values) {
    const value = pickFirstText(rawValue);
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function buildBulkFieldState(hydratedItems = [], comparableKey, form = createEmptyBuildingForm()) {
  const initialValue = pickFirstText(hydratedItems[0]?.initialComparable?.[comparableKey]);
  const sampleValues = dedupeComparableValues(
    hydratedItems.map((item) => item?.initialComparable?.[comparableKey])
  );
  const isMixed = sampleValues.length > 1;
  const formKeys = BULK_FIELD_FORM_MAP[comparableKey] || [];

  if (!isMixed && formKeys.length > 0) {
    for (const formKey of formKeys) {
      form[formKey] = pickFirstText(hydratedItems[0]?.form?.[formKey]);
    }
  }

  return {
    isMixed,
    sampleValues,
    initialValue: isMixed ? '' : initialValue
  };
}

export function buildBulkBuildingFormState(detailsList = []) {
  const items = Array.isArray(detailsList) ? detailsList.filter(Boolean) : [];
  const form = createEmptyBuildingForm();
  const initialComparable = createEmptyBuildingComparable();
  const fieldState = createEmptyBulkBuildingFieldState();

  if (items.length === 0) {
    return {
      form,
      initialComparable,
      fieldState,
      regionSlugs: []
    };
  }

  const hydratedItems = items.map((detail) => hydrateBuildingForm(detail));
  for (const comparableKey of Object.keys(fieldState)) {
    const nextFieldState = buildBulkFieldState(hydratedItems, comparableKey, form);
    fieldState[comparableKey] = nextFieldState;
    initialComparable[comparableKey] = nextFieldState.initialValue;
  }

  const regionSlugs = [];
  const seenRegionSlugs = new Set();
  for (const detail of items) {
    for (const regionSlug of Array.isArray(detail?.region_slugs) ? detail.region_slugs : []) {
      const normalizedSlug = String(regionSlug || '').trim();
      if (!normalizedSlug || seenRegionSlugs.has(normalizedSlug)) continue;
      seenRegionSlugs.add(normalizedSlug);
      regionSlugs.push(normalizedSlug);
    }
  }

  return {
    form,
    initialComparable,
    fieldState,
    regionSlugs
  };
}

export function normalizeStyleForBuildingForm(value) {
  const raw = pickFirstText(value).split(';')[0];
  return normalizeArchitectureStyleKey(raw);
}

export function buildAddressFromBuildingForm(formValue = createEmptyBuildingForm()) {
  return buildAddressText({
    full: formValue.addressFull,
    postcode: formValue.addressPostcode,
    city: formValue.addressCity,
    place: formValue.addressPlace,
    street: formValue.addressStreet,
    housenumber: formValue.addressHouseNumber
  }, pickFirstText);
}

export function buildBuildingComparableSnapshot(formValue = createEmptyBuildingForm()) {
  return {
    name: pickFirstText(formValue.name),
    style: normalizeArchitectureStyleKey(formValue.style),
    design: pickFirstText(formValue.design),
    designRef: pickFirstText(formValue.designRef),
    designYear: pickFirstText(formValue.designYear),
    material: normalizeBuildingMaterialSelection(formValue.material),
    colour: pickFirstText(formValue.colour).toLowerCase(),
    levels: pickFirstText(formValue.levels),
    yearBuilt: pickFirstText(formValue.yearBuilt),
    architect: pickFirstText(formValue.architect),
    address: buildAddressFromBuildingForm(formValue),
    archimapDescription: pickFirstText(formValue.archimapDescription)
  };
}

export function getEditedBuildingFields(currentSnapshot, initialSnapshot) {
  return Object.keys(currentSnapshot).filter((key) => currentSnapshot[key] !== (initialSnapshot?.[key] || ''));
}

export function buildOsmTagEntries(sourceTags = {}) {
  return Object.entries(sourceTags)
    .map(([key, value]) => ({
      key: String(key || '').trim(),
      value: value == null
        ? ''
        : (typeof value === 'object' ? JSON.stringify(value) : String(value))
    }))
    .filter((item) => item.key.length > 0)
    .sort((left, right) => left.key.localeCompare(right.key, 'en'));
}

export function hydrateBuildingForm(details) {
  const info = details?.properties?.archiInfo || {};
  const sourceTags = info?._sourceTags && typeof info._sourceTags === 'object' ? info._sourceTags : {};
  const hasExplicitFullAddress = Boolean(pickFirstText(sourceTags?.['addr:full'], sourceTags?.addr_full));
  const addressPartsPresent = hasStructuredAddressParts(sourceTags, pickFirstText);
  const canEditAddressFull = hasExplicitFullAddress || !addressPartsPresent;
  const fallbackAddress = pickFirstText(info.address, sourceTags?.['addr:full'], sourceTags?.addr_full);
  const nextAddressFields = parseAddressFields(sourceTags, pickFirstText, {
    fallbackAddress,
    allowFallbackAsFull: canEditAddressFull
  });
  const materialSelection = normalizeBuildingMaterialSelection(
    info.material ?? sourceTags?.['building:material'] ?? sourceTags?.material,
    info.material_concrete ?? sourceTags?.['building:material:concrete'] ?? sourceTags?.material_concrete
  );
  const form = {
    name: pickFirstText(info.name, sourceTags?.name, sourceTags?.['name:ru'], sourceTags?.['name:en']),
    levels: normalizeIntegerField(info.levels ?? sourceTags?.['building:levels'] ?? sourceTags?.levels, 0, 300),
    yearBuilt: normalizeIntegerField(
      info.year_built ?? sourceTags?.['building:year'] ?? sourceTags?.year_built ?? sourceTags?.start_date,
      1000,
      2100
    ),
    designYear: normalizeIntegerField(
      info.design_year ?? sourceTags?.['design:year'] ?? sourceTags?.design_year,
      1000,
      2100
    ),
    architect: pickFirstText(info.architect, sourceTags?.architect, sourceTags?.architect_name),
    style: normalizeStyleForBuildingForm(
      info.styleRaw ?? info.style ?? sourceTags?.['building:architecture'] ?? sourceTags?.architecture ?? sourceTags?.style
    ),
    design: pickFirstText(info.design, sourceTags?.design),
    designRef: pickFirstText(info.design_ref, sourceTags?.['design:ref'], sourceTags?.design_ref),
    material: materialSelection,
    colour: pickFirstText(info.colour, sourceTags?.['building:colour'], sourceTags?.colour),
    archimapDescription: pickFirstText(info.archimap_description, info.description),
    addressFull: nextAddressFields.full,
    addressPostcode: nextAddressFields.postcode,
    addressCity: nextAddressFields.city,
    addressPlace: nextAddressFields.place,
    addressStreet: nextAddressFields.street,
    addressHouseNumber: nextAddressFields.housenumber
  };

  const synthesizedTags = { ...sourceTags };
  if (pickFirstText(info.style)) synthesizedTags['building:architecture'] = info.style;
  if (pickFirstText(info.design)) synthesizedTags.design = info.design;
  if (pickFirstText(info.design_ref)) synthesizedTags['design:ref'] = info.design_ref;
  if (pickFirstText(info.design_year)) synthesizedTags['design:year'] = info.design_year;
  if (pickFirstText(info.material)) {
    const split = splitBuildingMaterialSelection(info.material);
    
    // Clear all possible material tags first
    delete synthesizedTags['material'];
    delete synthesizedTags['building:material'];
    delete synthesizedTags['material_concrete'];
    delete synthesizedTags['building:material:concrete'];
    
    synthesizedTags['building:material'] = split.material;
    if (split.materialConcrete) {
      synthesizedTags['building:material:concrete'] = split.materialConcrete;
    }
  }
  
  // Also check if info.material_concrete was explicitly provided independently
  if (pickFirstText(info.material_concrete)) {
    synthesizedTags['building:material:concrete'] = info.material_concrete;
    if (!synthesizedTags['building:material']) {
      synthesizedTags['building:material'] = 'concrete';
    }
  }
  if (pickFirstText(info.colour)) synthesizedTags[sourceTags['colour'] ? 'colour' : 'building:colour'] = info.colour;
  if (pickFirstText(info.levels)) synthesizedTags[sourceTags['levels'] ? 'levels' : 'building:levels'] = info.levels;
  if (pickFirstText(info.year_built)) {
    if (sourceTags['start_date']) synthesizedTags['start_date'] = info.year_built;
    else if (sourceTags['year_built']) synthesizedTags['year_built'] = info.year_built;
    else synthesizedTags['building:year_built'] = info.year_built;
  }
  if (pickFirstText(info.architect)) synthesizedTags[sourceTags['architect_name'] ? 'architect_name' : 'architect'] = info.architect;
  if (pickFirstText(info.name)) synthesizedTags['name'] = info.name;

  return {
    form,
    initialComparable: buildBuildingComparableSnapshot(form),
    canEditAddressFull,
    sourceTags,
    osmTagEntries: buildOsmTagEntries(synthesizedTags)
  };
}

export function resolveDisplayBuildingStyle(value, localeValue) {
  const raw = pickFirstText(value);
  if (!raw) return '';
  return toHumanArchitectureStyle(raw, localeValue) || raw;
}
