const { DEFAULT_FILTER_PRESETS } = require('../filter-presets-defaults');

const FILTER_PRESET_LAYER_MODES = new Set(['and', 'or', 'layer']);
const FILTER_PRESET_RULE_OPS = new Set([
  'contains',
  'equals',
  'not_equals',
  'starts_with',
  'exists',
  'not_exists',
  'greater_than',
  'greater_or_equals',
  'less_than',
  'less_or_equals'
]);
const FILTER_PRESET_NUMERIC_OPS = new Set([
  'greater_than',
  'greater_or_equals',
  'less_than',
  'less_or_equals'
]);
const FILTER_PRESET_COLOR_RE = /^#[0-9a-f]{6}$/i;
const FILTER_PRESET_LOCALE_RE = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/i;

function normalizePresetId(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  return numeric;
}

function normalizePresetKey(value) {
  const text = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return text || '';
}

function normalizePresetName(value) {
  return String(value || '').trim().slice(0, 160);
}

function normalizePresetDescription(value) {
  const text = String(value || '').trim().slice(0, 1000);
  return text || null;
}

function normalizePresetLocaleKey(value) {
  const locale = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .slice(0, 32);
  if (!locale) return '';
  if (!FILTER_PRESET_LOCALE_RE.test(locale)) return '';
  return locale;
}

function normalizePresetNameI18n(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const entries = [];
  for (const [rawLocale, rawName] of Object.entries(source)) {
    const locale = normalizePresetLocaleKey(rawLocale);
    if (!locale) continue;
    const name = normalizePresetName(rawName);
    if (!name) continue;
    entries.push([locale, name]);
  }
  entries.sort((left, right) => String(left[0] || '').localeCompare(String(right[0] || ''), 'en', { sensitivity: 'base' }));
  return Object.fromEntries(entries);
}

function pickPreferredName(nameI18n: LooseRecord = {}, fallback = null) {
  const source = nameI18n && typeof nameI18n === 'object' ? nameI18n : {};
  for (const locale of ['en', 'ru']) {
    const candidate = normalizePresetName(source[locale]);
    if (candidate) return candidate;
  }
  for (const value of Object.values(source)) {
    const candidate = normalizePresetName(value);
    if (candidate) return candidate;
  }
  return normalizePresetName(fallback);
}

function parsePresetNameI18nJson(rawValue, fallbackName = null) {
  if (rawValue == null || String(rawValue).trim() === '') {
    const fallback = normalizePresetName(fallbackName);
    return fallback ? { en: fallback } : {};
  }
  try {
    const parsed = JSON.parse(String(rawValue));
    const normalized = normalizePresetNameI18n(parsed);
    if (Object.keys(normalized).length > 0) return normalized;
  } catch {
    // fall through to fallback
  }
  const fallback = normalizePresetName(fallbackName);
  return fallback ? { en: fallback } : {};
}

function parseNumericFilterValue(rawValue) {
  const text = String(rawValue ?? '').trim().replace(',', '.');
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function normalizeLayerMode(value) {
  const mode = String(value || 'layer').trim().toLowerCase();
  return FILTER_PRESET_LAYER_MODES.has(mode) ? mode : null;
}

function normalizeLayerColor(value) {
  const color = String(value || '').trim();
  return FILTER_PRESET_COLOR_RE.test(color) ? color.toLowerCase() : null;
}

function normalizeRule(rawRule: LooseRecord = {}) {
  const key = String(rawRule?.key || '').trim();
  if (!key) return { value: null, error: 'Rule key is required' };

  const op = String(rawRule?.op || 'contains').trim();
  if (!FILTER_PRESET_RULE_OPS.has(op)) {
    return { value: null, error: `Unsupported rule operator "${op}"` };
  }

  const value = String(rawRule?.value || '').trim();
  if (FILTER_PRESET_NUMERIC_OPS.has(op) && !Number.isFinite(parseNumericFilterValue(value))) {
    return { value: null, error: `Rule value for "${op}" must be numeric` };
  }

  if (!FILTER_PRESET_NUMERIC_OPS.has(op) && !['exists', 'not_exists'].includes(op) && value.length === 0) {
    return { value: null, error: 'Rule value is required for the selected operator' };
  }

  return {
    value: {
      key,
      op,
      value
    },
    error: null
  };
}

function normalizeLayers(rawLayers = []) {
  const input = Array.isArray(rawLayers) ? rawLayers : [];
  if (input.length === 0) {
    return { layers: [], error: 'Preset must contain at least one layer' };
  }
  if (input.length > 32) {
    return { layers: [], error: 'Preset cannot have more than 32 layers' };
  }

  const layers = [];
  for (let index = 0; index < input.length; index += 1) {
    const rawLayer = input[index] || {};
    const id = String(rawLayer?.id || '').trim().slice(0, 128) || `preset-layer-${index + 1}`;
    const color = normalizeLayerColor(rawLayer?.color);
    if (!color) {
      return { layers: [], error: 'Layer color must be a 6-digit hex color' };
    }
    const mode = normalizeLayerMode(rawLayer?.mode);
    if (!mode) {
      return { layers: [], error: 'Layer mode must be one of: and, or, layer' };
    }

    const rawRules = Array.isArray(rawLayer?.rules) ? rawLayer.rules : [];
    if (rawRules.length === 0) {
      return { layers: [], error: 'Each layer must contain at least one rule' };
    }
    if (rawRules.length > 32) {
      return { layers: [], error: 'Each layer can contain at most 32 rules' };
    }

    const rules = [];
    for (const rawRule of rawRules) {
      const normalizedRule = normalizeRule(rawRule);
      if (normalizedRule.error) {
        return { layers: [], error: normalizedRule.error };
      }
      rules.push(normalizedRule.value);
    }

    layers.push({
      id,
      color,
      priority: index,
      mode,
      rules
    });
  }

  return { layers, error: null };
}

function clonePresetLayers(layers = []) {
  return JSON.parse(JSON.stringify(Array.isArray(layers) ? layers : []));
}

function mapPresetRow(row: LooseRecord) {
  if (!row || typeof row !== 'object') return null;
  let parsedLayers = [];
  try {
    parsedLayers = JSON.parse(String(row.layers_json || '[]'));
  } catch {
    parsedLayers = [];
  }
  const nameI18n = parsePresetNameI18nJson(row.preset_name_i18n_json, row.preset_name);
  const name = normalizePresetName(row.preset_name) || pickPreferredName(nameI18n, '');
  const normalizedLayers = normalizeLayers(parsedLayers);
  return {
    id: Number(row.id || 0),
    key: String(row.preset_key || '').trim(),
    name,
    nameI18n,
    description: row.preset_description == null ? null : String(row.preset_description),
    layers: normalizedLayers.layers,
    createdAt: row.created_at ? String(row.created_at) : null,
    updatedAt: row.updated_at ? String(row.updated_at) : null,
    updatedBy: row.updated_by ? String(row.updated_by) : null
  };
}

function createPresetsDomain(context: LooseRecord = {}) {
  const {
    db,
    ensureBootstrapped,
    normalizeNullableText
  } = context;

  const selectAllPresets = db.prepare(`
    SELECT
      id,
      preset_key,
      preset_name,
      preset_name_i18n_json,
      preset_description,
      layers_json,
      created_at,
      updated_at,
      updated_by
    FROM data_filter_presets
    ORDER BY lower(preset_name), id
  `);
  const selectPresetById = db.prepare(`
    SELECT
      id,
      preset_key,
      preset_name,
      preset_name_i18n_json,
      preset_description,
      layers_json,
      created_at,
      updated_at,
      updated_by
    FROM data_filter_presets
    WHERE id = ?
    LIMIT 1
  `);
  const selectPresetByKey = db.prepare(`
    SELECT
      id,
      preset_key,
      preset_name,
      preset_name_i18n_json,
      preset_description,
      layers_json,
      created_at,
      updated_at,
      updated_by
    FROM data_filter_presets
    WHERE preset_key = ?
    LIMIT 1
  `);
  const countPresets = db.prepare(`
    SELECT COUNT(*) AS total
    FROM data_filter_presets
  `);
  const insertPreset = db.prepare(`
    INSERT INTO data_filter_presets (
      preset_key,
      preset_name,
      preset_name_i18n_json,
      preset_description,
      layers_json,
      created_at,
      updated_at,
      updated_by
    )
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
  `);
  const updatePreset = db.prepare(`
    UPDATE data_filter_presets
    SET
      preset_key = ?,
      preset_name = ?,
      preset_name_i18n_json = ?,
      preset_description = ?,
      layers_json = ?,
      updated_at = datetime('now'),
      updated_by = ?
    WHERE id = ?
  `);
  const deletePreset = db.prepare(`
    DELETE FROM data_filter_presets
    WHERE id = ?
  `);

  let defaultBootstrapDone = false;
  let defaultBootstrapPromise = null;

  async function listFilterPresets() {
    const rows = await selectAllPresets.all();
    return (Array.isArray(rows) ? rows : []).map(mapPresetRow).filter(Boolean);
  }

  async function getFilterPresetById(id) {
    const presetId = normalizePresetId(id);
    if (!presetId) return null;
    return mapPresetRow(await selectPresetById.get(presetId));
  }

  async function ensureDefaultFilterPresets(actor = 'system') {
    if (defaultBootstrapDone) return;
    if (defaultBootstrapPromise) {
      await defaultBootstrapPromise;
      return;
    }

    defaultBootstrapPromise = (async () => {
      await ensureBootstrapped();
      const existingCount = Number((await countPresets.get())?.total || 0);
      if (existingCount > 0) {
        defaultBootstrapDone = true;
        return;
      }

      const updatedBy = normalizeNullableText(actor, 160);
      const tx = db.transaction(async () => {
        for (const preset of DEFAULT_FILTER_PRESETS) {
          const normalizedLayers = normalizeLayers(clonePresetLayers(preset.layers));
          if (normalizedLayers.error) continue;
          await insertPreset.run(
            String(preset.key),
            String(preset.name),
            JSON.stringify(normalizePresetNameI18n(preset.nameI18n || {})),
            normalizePresetDescription(preset.description),
            JSON.stringify(normalizedLayers.layers),
            updatedBy
          );
        }
      });
      await tx();
      defaultBootstrapDone = true;
    })();

    try {
      await defaultBootstrapPromise;
    } finally {
      defaultBootstrapPromise = null;
    }
  }

  async function getFilterPresetsForAdmin() {
    await ensureBootstrapped();
    await ensureDefaultFilterPresets('preset-bootstrap');
    return {
      source: 'db',
      items: await listFilterPresets()
    };
  }

  async function getFilterPresetsForRuntime() {
    await ensureBootstrapped();
    await ensureDefaultFilterPresets('preset-bootstrap');
    return await listFilterPresets();
  }

  async function saveFilterPreset(input: LooseRecord = {}, actor = null) {
    await ensureBootstrapped();
    await ensureDefaultFilterPresets('preset-bootstrap');

    const presetId = normalizePresetId(input?.id);
    const existing = presetId ? await getFilterPresetById(presetId) : null;
    if (presetId && !existing) {
      throw new Error('Filter preset not found');
    }

    const hasNameInput = Object.prototype.hasOwnProperty.call(input || {}, 'name');
    const hasNameI18nInput = Object.prototype.hasOwnProperty.call(input || {}, 'nameI18n');
    const inputNameI18n = normalizePresetNameI18n(hasNameI18nInput ? input?.nameI18n : existing?.nameI18n);
    const existingName = normalizePresetName(existing?.name);
    const inputName = hasNameInput ? normalizePresetName(input?.name) : '';
    const preferredName = pickPreferredName(inputNameI18n, existingName);
    const name = hasNameInput
      ? (inputName || preferredName)
      : (hasNameI18nInput ? preferredName : (existingName || preferredName));
    if (!name) {
      throw new Error('Filter preset name is required');
    }

    const nameI18n = {
      ...inputNameI18n,
      ...(inputNameI18n.en ? {} : { en: name })
    };

    const keyFromInput = normalizePresetKey(input?.key);
    const fallbackKey = normalizePresetKey(inputName || pickPreferredName(inputNameI18n));
    const key = keyFromInput || existing?.key || fallbackKey;
    if (!key) {
      throw new Error('Filter preset key is required');
    }

    const description = normalizePresetDescription(
      Object.prototype.hasOwnProperty.call(input || {}, 'description')
        ? input.description
        : existing?.description
    );

    const layersInput = Object.prototype.hasOwnProperty.call(input || {}, 'layers')
      ? input.layers
      : existing?.layers;
    const normalizedLayers = normalizeLayers(clonePresetLayers(layersInput));
    if (normalizedLayers.error) {
      throw new Error(normalizedLayers.error);
    }

    const updatedBy = normalizeNullableText(actor, 160);

    const tx = db.transaction(async () => {
      const byKey = await selectPresetByKey.get(key);
      const byKeyId = normalizePresetId(byKey?.id);
      if (byKeyId && byKeyId !== presetId) {
        throw new Error(`Filter preset key "${key}" is already used`);
      }

      if (presetId) {
        await updatePreset.run(
          key,
          name,
          JSON.stringify(nameI18n),
          description,
          JSON.stringify(normalizedLayers.layers),
          updatedBy,
          presetId
        );
        return presetId;
      }

      const inserted = await insertPreset.run(
        key,
        name,
        JSON.stringify(nameI18n),
        description,
        JSON.stringify(normalizedLayers.layers),
        updatedBy
      );
      const nextId = normalizePresetId(inserted?.lastInsertRowid);
      if (nextId) return nextId;
      const byKeyAfterInsert = await selectPresetByKey.get(key);
      const createdId = normalizePresetId(byKeyAfterInsert?.id);
      if (!createdId) {
        throw new Error('Failed to create filter preset');
      }
      return createdId;
    });

    const savedId = await tx();
    return getFilterPresetById(savedId);
  }

  async function deleteFilterPresetById(id) {
    await ensureBootstrapped();
    await ensureDefaultFilterPresets('preset-bootstrap');
    const presetId = normalizePresetId(id);
    if (!presetId) {
      throw new Error('Invalid filter preset id');
    }
    const existing = await getFilterPresetById(presetId);
    if (!existing) {
      throw new Error('Filter preset not found');
    }
    await deletePreset.run(presetId);
    return existing;
  }

  return {
    ensureDefaultFilterPresets,
    getFilterPresetsForAdmin,
    getFilterPresetsForRuntime,
    saveFilterPreset,
    deleteFilterPresetById
  };
}

module.exports = {
  createPresetsDomain,
  normalizePresetKey
};
