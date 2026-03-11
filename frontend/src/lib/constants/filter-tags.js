export const FILTER_TAG_LABEL_KEYS = Object.freeze({
  architect: 'header.filterLabels.architect',
  'building:architecture': 'header.filterLabels.building_architecture',
  style: 'header.filterLabels.style',
  year_built: 'header.filterLabels.year_built',
  year_of_construction: 'header.filterLabels.year_of_construction',
  start_date: 'header.filterLabels.start_date',
  'building:start_date': 'header.filterLabels.building_start_date',
  'building:year': 'header.filterLabels.building_year',
  'building:levels': 'header.filterLabels.building_levels',
  levels: 'header.filterLabels.levels',
  'building:colour': 'header.filterLabels.building_colour',
  'building:material': 'header.filterLabels.building_material',
  'building:prefabricated': 'header.filterLabels.building_prefabricated',
  'building:height': 'header.filterLabels.building_height',
  'roof:colour': 'header.filterLabels.roof_colour',
  'roof:shape': 'header.filterLabels.roof_shape',
  'roof:levels': 'header.filterLabels.roof_levels',
  'roof:orientation': 'header.filterLabels.roof_orientation',
  height: 'header.filterLabels.height',
  colour: 'header.filterLabels.colour',
  material: 'header.filterLabels.material',
  name: 'header.filterLabels.name',
  'name:ru': 'header.filterLabels.name_ru',
  'name:en': 'header.filterLabels.name_en',
  address: 'header.filterLabels.address',
  'addr:full': 'header.filterLabels.addr_full',
  'addr:city': 'header.filterLabels.addr_city',
  'addr:street': 'header.filterLabels.addr_street',
  'addr:housenumber': 'header.filterLabels.addr_housenumber',
  'addr:postcode': 'header.filterLabels.addr_postcode',
  amenity: 'header.filterLabels.amenity',
  building: 'header.filterLabels.building'
});

export const PRIORITY_FILTER_TAG_KEYS = Object.freeze([
  'architect',
  'building:architecture',
  'style',
  'year_built',
  'year_of_construction',
  'start_date',
  'building:start_date',
  'building:year',
  'building:levels',
  'levels'
]);

export const APPEARANCE_FILTER_TAG_KEYS = Object.freeze([
  'building:colour',
  'building:material',
  'building:height',
  'roof:colour',
  'roof:shape',
  'roof:levels',
  'roof:orientation',
  'height',
  'colour',
  'material'
]);

export const APPEARANCE_FILTER_TAG_PREFIXES = Object.freeze([
  'roof:',
  'facade:',
  'building:facade',
  'building:cladding',
  'building:colour',
  'building:material',
  'building:height',
  'building:shape'
]);
