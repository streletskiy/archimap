const USER_EDIT_STATUS_VALUES = new Set(['pending', 'accepted', 'rejected', 'partially_accepted', 'superseded']);
const CONCRETE_BUILDING_MATERIAL_VARIANTS = new Map([
  ['concrete_panels', 'panels'],
  ['concrete_blocks', 'blocks'],
  ['concrete_monolith', 'monolith']
]);
const ROOF_SHAPE_CANONICAL_VALUES = new Set([
  'flat',
  'gabled',
  'gabled_height_moved',
  'skillion',
  'saltbox',
  'hipped',
  'half-hipped',
  'side_hipped',
  'side_half-hipped',
  'hipped-and-gabled',
  'mansard',
  'gambrel',
  'bellcast_gable',
  'pyramidal',
  'crosspitched',
  'sawtooth',
  'butterfly',
  'cone',
  'dome',
  'onion',
  'round'
]);
const ROOF_SHAPE_NORMALIZED_ALIASES = new Map([
  ['gabledheightmoved', 'gabled_height_moved'],
  ['halfhipped', 'half-hipped'],
  ['sidehipped', 'side_hipped'],
  ['sidehalfhipped', 'side_half-hipped'],
  ['hippedandgabled', 'hipped-and-gabled'],
  ['bellcastgable', 'bellcast_gable']
]);
const ARCHI_EDITED_FIELD_ALIASES = new Map([
  ['name', 'name'],
  ['style', 'style'],
  ['design', 'design'],
  ['designref', 'design_ref'],
  ['design_ref', 'design_ref'],
  ['designyear', 'design_year'],
  ['design_year', 'design_year'],
  ['material', 'material'],
  ['levels', 'levels'],
  ['yearbuilt', 'year_built'],
  ['year_built', 'year_built'],
  ['architect', 'architect'],
  ['address', 'address'],
  ['colour', 'colour'],
  ['color', 'colour'],
  ['roofshape', 'roof_shape'],
  ['roof_shape', 'roof_shape'],
  ['roof-shape', 'roof_shape'],
  ['roof:shape', 'roof_shape'],
  ['archimapdescription', 'archimap_description'],
  ['archimap_description', 'archimap_description'],
  ['description', 'archimap_description']
]);

function normalizeUserEditStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (USER_EDIT_STATUS_VALUES.has(normalized)) return normalized;
  return 'pending';
}

function sanitizeFieldText(value, maxLen = 500) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLen);
}

function sanitizeYearInRange(value, min = 1000, max = 2100) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function normalizeBuildingMaterialSelectionKey(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (CONCRETE_BUILDING_MATERIAL_VARIANTS.has(text)) return text;
  if (text.startsWith('concrete_')) {
    const suffix = text.slice('concrete_'.length);
    if (CONCRETE_BUILDING_MATERIAL_VARIANTS.has(`concrete_${suffix}`)) return `concrete_${suffix}`;
  }
  return text;
}

function normalizeConcreteBuildingMaterialVariant(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'panels' || text === 'blocks' || text === 'monolith') return text;
  if (text.startsWith('concrete_')) {
    const suffix = text.slice('concrete_'.length);
    if (suffix === 'panels' || suffix === 'blocks' || suffix === 'monolith') return suffix;
  }
  return '';
}

function normalizeRoofShapeSelection(value) {
  const text = sanitizeFieldText(value, 120);
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return null;
  if (ROOF_SHAPE_CANONICAL_VALUES.has(normalized)) return normalized;
  const collapsed = normalized.replace(/[^a-z0-9]+/g, '');
  if (ROOF_SHAPE_NORMALIZED_ALIASES.has(normalized)) return ROOF_SHAPE_NORMALIZED_ALIASES.get(normalized);
  if (ROOF_SHAPE_NORMALIZED_ALIASES.has(collapsed)) return ROOF_SHAPE_NORMALIZED_ALIASES.get(collapsed);
  return normalized;
}

function splitBuildingMaterialSelection(value) {
  const selection = normalizeBuildingMaterialSelectionKey(value);
  const concreteVariant = CONCRETE_BUILDING_MATERIAL_VARIANTS.get(selection) || '';
  if (concreteVariant) {
    return {
      material: 'concrete',
      material_concrete: concreteVariant
    };
  }
  return {
    material: selection || null,
    material_concrete: null
  };
}

function sanitizeYearBuilt(value) {
  return sanitizeYearInRange(value, 1000, 2100);
}

function sanitizeProjectYear(value) {
  return sanitizeYearInRange(value, 1000, 2100);
}

function sanitizeLevels(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 300) return null;
  return parsed;
}

function sanitizeArchiPayload(body) {
  const yearRaw = body?.yearBuilt ?? body?.year_built;
  const designYearRaw = body?.designYear ?? body?.design_year;
  const levelsRaw = body?.levels;
  const yearBuilt = sanitizeYearBuilt(yearRaw);
  const designYear = sanitizeProjectYear(designYearRaw);
  const levels = sanitizeLevels(levelsRaw);
  const materialSelection = String(body?.material ?? '').trim();
  const explicitMaterialConcrete = normalizeConcreteBuildingMaterialVariant(body?.materialConcrete ?? body?.material_concrete);
  const explicitMaterialConcreteRaw = sanitizeFieldText(body?.materialConcrete ?? body?.material_concrete, 40);
  const roofShape = normalizeRoofShapeSelection(body?.roofShape ?? body?.roof_shape ?? body?.['roof:shape']);
  const splitMaterial = splitBuildingMaterialSelection(materialSelection);
  const material = splitMaterial.material;
  const materialConcrete = explicitMaterialConcrete || splitMaterial.material_concrete;
  if ((yearRaw !== null && yearRaw !== undefined && String(yearRaw).trim() !== '') && yearBuilt == null) {
    return { code: 'ERR_INVALID_YEAR_BUILT', error: 'Year built must be an integer between 1000 and 2100' };
  }
  if ((designYearRaw !== null && designYearRaw !== undefined && String(designYearRaw).trim() !== '') && designYear == null) {
    return { code: 'ERR_INVALID_DESIGN_YEAR', error: 'Project year must be an integer between 1000 and 2100' };
  }
  if ((levelsRaw !== null && levelsRaw !== undefined && String(levelsRaw).trim() !== '') && levels == null) {
    return { code: 'ERR_INVALID_LEVELS', error: 'Levels must be an integer between 0 and 300' };
  }
  if (explicitMaterialConcreteRaw && !explicitMaterialConcrete) {
    return { code: 'ERR_INVALID_INPUT', error: 'Invalid building:material:concrete value' };
  }
  if (explicitMaterialConcrete && splitMaterial.material_concrete && explicitMaterialConcrete !== splitMaterial.material_concrete) {
    return { code: 'ERR_INVALID_INPUT', error: 'Conflicting building material concrete values were provided' };
  }
  if (materialConcrete && material !== 'concrete') {
    return { code: 'ERR_INVALID_INPUT', error: 'building:material:concrete can only be used together with building:material=concrete' };
  }
  if (materialConcrete && !CONCRETE_BUILDING_MATERIAL_VARIANTS.has(`concrete_${materialConcrete}`)) {
    return { code: 'ERR_INVALID_INPUT', error: 'Invalid building:material:concrete value' };
  }
  return {
    value: {
      name: sanitizeFieldText(body?.name, 250),
      style: sanitizeFieldText(body?.style, 200),
      design: sanitizeFieldText(body?.design, 120),
      design_ref: sanitizeFieldText(body?.designRef ?? body?.design_ref, 500),
      design_year: designYear,
      material,
      material_concrete: materialConcrete,
      colour: sanitizeFieldText(body?.colour ?? body?.color, 120),
      levels,
      year_built: yearBuilt,
      architect: sanitizeFieldText(body?.architect, 200),
      address: sanitizeFieldText(body?.address, 300),
      roof_shape: roofShape,
      archimap_description: sanitizeFieldText(body?.archimapDescription ?? body?.archimap_description ?? body?.description, 1000)
    }
  };
}

function normalizeEditedFieldKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return null;
  return ARCHI_EDITED_FIELD_ALIASES.get(key) || null;
}

function sanitizeEditedFields(value) {
  const input = Array.isArray(value)
    ? value
    : (() => {
      if (typeof value !== 'string' || !value.trim()) return [];
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();

  const out = [];
  const seen = new Set();
  for (const item of input) {
    const normalized = normalizeEditedFieldKey(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

module.exports = {
  normalizeUserEditStatus,
  sanitizeFieldText,
  sanitizeYearInRange,
  sanitizeYearBuilt,
  sanitizeProjectYear,
  sanitizeLevels,
  splitBuildingMaterialSelection,
  sanitizeArchiPayload,
  sanitizeEditedFields,
  normalizeRoofShapeSelection,
  USER_EDIT_STATUS_VALUES
};
