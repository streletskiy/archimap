const USER_EDIT_STATUS_VALUES = new Set(['pending', 'accepted', 'rejected', 'partially_accepted', 'superseded']);
const CONCRETE_BUILDING_MATERIAL_VARIANTS = new Map([
  ['concrete_panels', 'panels'],
  ['concrete_blocks', 'blocks'],
  ['concrete_monolith', 'monolith']
]);
const ARCHI_EDITED_FIELD_ALIASES = new Map([
  ['name', 'name'],
  ['style', 'style'],
  ['material', 'material'],
  ['levels', 'levels'],
  ['yearbuilt', 'year_built'],
  ['year_built', 'year_built'],
  ['architect', 'architect'],
  ['address', 'address'],
  ['colour', 'colour'],
  ['color', 'colour'],
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
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 2100) return null;
  return parsed;
}

function sanitizeLevels(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 300) return null;
  return parsed;
}

function sanitizeArchiPayload(body) {
  const yearRaw = body?.yearBuilt ?? body?.year_built;
  const levelsRaw = body?.levels;
  const yearBuilt = sanitizeYearBuilt(yearRaw);
  const levels = sanitizeLevels(levelsRaw);
  const materialSelection = String(body?.material ?? '').trim();
  const explicitMaterialConcrete = normalizeConcreteBuildingMaterialVariant(body?.materialConcrete ?? body?.material_concrete);
  const explicitMaterialConcreteRaw = sanitizeFieldText(body?.materialConcrete ?? body?.material_concrete, 40);
  const splitMaterial = splitBuildingMaterialSelection(materialSelection);
  const material = splitMaterial.material;
  const materialConcrete = explicitMaterialConcrete || splitMaterial.material_concrete;
  if ((yearRaw !== null && yearRaw !== undefined && String(yearRaw).trim() !== '') && yearBuilt == null) {
    return { code: 'ERR_INVALID_YEAR_BUILT', error: 'Year built must be an integer between 1000 and 2100' };
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
      material,
      material_concrete: materialConcrete,
      colour: sanitizeFieldText(body?.colour ?? body?.color, 120),
      levels,
      year_built: yearBuilt,
      architect: sanitizeFieldText(body?.architect, 200),
      address: sanitizeFieldText(body?.address, 300),
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
  sanitizeYearBuilt,
  sanitizeLevels,
  splitBuildingMaterialSelection,
  sanitizeArchiPayload,
  sanitizeEditedFields,
  USER_EDIT_STATUS_VALUES
};
