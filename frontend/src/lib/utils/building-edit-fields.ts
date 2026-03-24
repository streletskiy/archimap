import { BUILDING_EDITABLE_FIELDS, normalizeEditedBuildingFields } from './text.js';

export const BUILDING_PART_EDITABLE_FIELDS = Object.freeze([
  'levels',
  'colour',
  'style',
  'material',
  'yearBuilt'
]);

export const BULK_BUILDING_EDITABLE_FIELDS = Object.freeze(
  BUILDING_EDITABLE_FIELDS.filter((field) => field !== 'address' && field !== 'name')
);

export function getBuildingEditableFields({
  isBulkSelection = false,
  hasBuildingPartSelection = false
} = {}) {
  if (hasBuildingPartSelection) return BUILDING_PART_EDITABLE_FIELDS;
  if (isBulkSelection) return BULK_BUILDING_EDITABLE_FIELDS;
  return BUILDING_EDITABLE_FIELDS;
}

export function filterBuildingEditedFields(value, options = {}) {
  return normalizeEditedBuildingFields(value, getBuildingEditableFields(options));
}
