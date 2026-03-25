const crypto = require('crypto');

const DEFAULT_AUTH_BASE_URL = 'https://www.openstreetmap.org';
const DEFAULT_API_BASE_URL = 'https://api.openstreetmap.org';
const DEFAULT_SCOPE = 'write_api write_changeset_comments';
const DEFAULT_CHANGESET_SOURCE = 'ArchiMap local architectural edits';
const DEFAULT_CHANGESET_CREATED_BY = 'ArchiMap OSM sync';

type LooseOsmError = Error & {
  status?: number;
  code?: string;
  details?: LooseRecord | null;
};

const makeOsmError = (message, { status = 500, code = null, details = null } = {}) => {
  const error = new Error(String(message || 'OSM sync error')) as LooseOsmError;
  error.status = status;
  if (code) {
    error.code = code;
  }
  if (details) {
    error.details = details;
  }
  return error;
};

function normalizeText(value, maxLength = 255) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, Math.max(1, maxLength)) : null;
}

function normalizeBaseUrl(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  try {
    const url = new URL(text);
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

function isMasterOsmAuthBaseUrl(value) {
  const normalized = normalizeBaseUrl(value, '');
  if (!normalized) return false;
  try {
    return new URL(normalized).hostname === 'master.apis.dev.openstreetmap.org';
  } catch {
    return false;
  }
}

function normalizeAuthBaseUrl(value) {
  return normalizeBaseUrl(value, DEFAULT_AUTH_BASE_URL) || DEFAULT_AUTH_BASE_URL;
}

function normalizeApiBaseUrl(value, authBaseUrl = DEFAULT_AUTH_BASE_URL) {
  const explicit = normalizeBaseUrl(value, '');
  if (explicit) return explicit;
  return isMasterOsmAuthBaseUrl(authBaseUrl)
    ? 'https://master.apis.dev.openstreetmap.org'
    : DEFAULT_API_BASE_URL;
}

function normalizeRedirectUri(value, baseUrl) {
  const explicit = String(value || '').trim();
  if (explicit) {
    try {
      const url = new URL(explicit);
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/+$/, '');
    } catch {
      return null;
    }
  }
  const base = String(baseUrl || '').trim();
  if (!base) return null;
  try {
    return new URL('/api/admin/app-settings/osm/oauth/callback', base).toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function encryptSecret(secret, plaintext) {
  const value = String(plaintext || '');
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

function decryptSecret(secret, encoded) {
  const value = String(encoded || '').trim();
  if (!value) return '';
  const parts = value.split('.');
  if (parts.length !== 3) return '';
  try {
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const encrypted = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', secret, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

async function createPkceChallenge(verifier) {
  const verifierBytes = Buffer.from(String(verifier || ''), 'utf8');
  const subtle = crypto.webcrypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', verifierBytes);
    return Buffer.from(digest).toString('base64url');
  }
  return crypto.createHash('sha256').update(verifierBytes).digest('base64url');
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map((item) => stableJson(item));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableJson(value[key]);
  return out;
}

function parseJson(raw, fallback = null) {
  if (raw == null || String(raw).trim() === '') return fallback;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

function tagsFingerprint(raw) {
  const parsed = parseJson(raw, {});
  return JSON.stringify(stableJson(parsed && typeof parsed === 'object' ? parsed : {}));
}

function parseTags(raw) {
  const parsed = parseJson(raw, {});
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attrsToObject(text = '') {
  const attrs = {};
  const re = /([A-Za-z_][A-Za-z0-9_.:-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(text || '')))) attrs[String(match[1])] = unescapeXml(match[2]);
  return attrs;
}

function attrsToString(attrs: LooseRecord = {}) {
  return Object.keys(attrs)
    .filter((key) => attrs[key] != null)
    .map((key) => `${key}="${escapeXml(attrs[key])}"`)
    .join(' ');
}

function parseElementXml(xmlText) {
  const text = String(xmlText || '').trim();
  const match = text.match(/<\s*(node|way|relation)\b([^>]*)>([\s\S]*)<\/\s*\1\s*>/i);
  if (!match) throw new Error('Unexpected OSM element XML');
  const type = String(match[1]).trim().toLowerCase();
  const attrs = attrsToObject(match[2]);
  const inner = String(match[3] || '');
  const tagIndex = inner.indexOf('<tag ');
  const beforeTags = tagIndex >= 0 ? inner.slice(0, tagIndex).trimEnd() : inner.trimEnd();
  const tags = {};
  for (const tagMatch of inner.matchAll(/<tag\s+k="([^"]*)"\s+v="([^"]*)"\s*\/>/g)) {
    const key = unescapeXml(tagMatch[1]);
    if (key) tags[key] = unescapeXml(tagMatch[2]);
  }
  return { type, attrs, beforeTags, tags, rawXml: text };
}

function parseGeneralSettingsRow(row: LooseRecord) {
  return {
    appDisplayName: row?.app_display_name ? String(row.app_display_name) : 'archimap',
    appBaseUrl: row?.app_base_url ? String(row.app_base_url) : ''
  };
}

function parseSyncSummary(raw) {
  const parsed = parseJson(raw, null);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function cloneTagMap(tags: LooseRecord = {}) {
  return Object.keys(tags || {}).reduce((acc, key) => {
    acc[key] = tags[key];
    return acc;
  }, {});
}

function normalizeStateValue(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeMaterialValue(material, materialConcrete = null) {
  const normalized = normalizeStateValue(material);
  const concrete = normalizeStateValue(materialConcrete);
  if (!normalized) return null;
  if (normalized === 'concrete' && concrete) return `concrete_${concrete}`;
  return normalized;
}

function stateFromLocalRow(row: LooseRecord = {}) {
  return {
    name: normalizeStateValue(row.local_name),
    style: normalizeStateValue(row.local_style),
    design: normalizeStateValue(row.local_design),
    design_ref: normalizeStateValue(row.local_design_ref),
    design_year: normalizeStateValue(row.local_design_year),
    material: normalizeMaterialValue(row.local_material, row.local_material_concrete),
    colour: normalizeStateValue(row.local_colour),
    levels: normalizeStateValue(row.local_levels),
    year_built: normalizeStateValue(row.local_year_built),
    architect: normalizeStateValue(row.local_architect),
    address: normalizeStateValue(row.local_address),
    description: normalizeStateValue(row.local_archimap_description || row.local_description)
  };
}

function stateFromContourTags(tags: LooseRecord = {}) {
  return {
    name: normalizeStateValue(tags.name),
    style: normalizeStateValue(tags['building:architecture'] || tags.architecture || tags.style),
    design: normalizeStateValue(tags.design),
    design_ref: normalizeStateValue(tags['design:ref'] || tags.design_ref),
    design_year: normalizeStateValue(tags['design:year'] || tags.design_year),
    material: normalizeMaterialValue(tags['building:material'] || tags.material),
    colour: normalizeStateValue(tags['building:colour'] || tags.colour),
    levels: normalizeStateValue(tags['building:levels'] || tags.levels),
    year_built: normalizeStateValue(tags['building:year'] || tags.start_date || tags.construction_date || tags.year_built),
    architect: normalizeStateValue(tags.architect || tags.architect_name),
    address: normalizeStateValue(tags['addr:full'] || tags['addr:full:en']),
    description: normalizeStateValue(tags.description)
  };
}

function diffStates(before: LooseRecord = {}, after: LooseRecord = {}) {
  const changed = [];
  const keys = ['name', 'style', 'design', 'design_ref', 'design_year', 'material', 'colour', 'levels', 'year_built', 'architect', 'address', 'description'];
  for (const key of keys) {
    if (before[key] !== after[key]) {
      changed.push({ key, before: before[key] ?? null, after: after[key] ?? null });
    }
  }
  return changed;
}

function parseEditedFields(raw) {
  const parsed = parseJson(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((value) => String(value || '').trim()).filter(Boolean);
}

function controlledKeysForField(field) {
  switch (field) {
    case 'name':
      return ['name', 'name:ru', 'official_name'];
    case 'style':
      return ['building:architecture', 'architecture', 'style'];
    case 'design':
      return ['design'];
    case 'design_ref':
      return ['design:ref', 'design_ref'];
    case 'design_year':
      return ['design:year', 'design_year'];
    case 'material':
      return ['building:material', 'material', 'building:material:concrete', 'material_concrete'];
    case 'colour':
      return ['building:colour', 'colour'];
    case 'levels':
      return ['building:levels', 'levels'];
    case 'year_built':
      return ['building:year', 'start_date', 'construction_date', 'year_built'];
    case 'architect':
      return ['architect', 'architect_name'];
    case 'address':
      return ['addr:full', 'addr:full:en'];
    case 'description':
      return ['description'];
    default:
      return [];
  }
}

function applyFieldToTagMap(tags: LooseRecord, field, value, explicitlyEdited = false) {
  const normalized = normalizeStateValue(value);
  const keys = controlledKeysForField(field);
  if (keys.length === 0) return [];
  if (normalized == null) {
    if (!explicitlyEdited) return [];
    const removedKeys = [];
    for (const key of keys) delete tags[key];
    removedKeys.push(...keys);
    return removedKeys;
  }

  switch (field) {
    case 'name':
      tags.name = normalized;
      return [];
    case 'style':
      tags['building:architecture'] = normalized;
      delete tags.architecture;
      delete tags.style;
      return ['architecture', 'style'];
    case 'design':
      tags.design = normalized;
      return [];
    case 'design_ref':
      tags['design:ref'] = normalized;
      delete tags.design_ref;
      return [];
    case 'design_year':
      tags['design:year'] = normalized;
      delete tags.design_year;
      return [];
    case 'material':
      if (normalized.startsWith('concrete_')) {
        tags['building:material'] = 'concrete';
        tags['building:material:concrete'] = normalized.slice('concrete_'.length);
      } else {
        tags['building:material'] = normalized;
        delete tags['building:material:concrete'];
      }
      delete tags.material;
      delete tags.material_concrete;
      return ['material', 'material_concrete'];
    case 'colour':
      tags['building:colour'] = normalized;
      tags.colour = normalized;
      return [];
    case 'levels':
      tags['building:levels'] = normalized;
      tags.levels = normalized;
      return [];
    case 'year_built':
      tags['building:year'] = normalized;
      return [];
    case 'architect':
      tags.architect = normalized;
      tags.architect_name = normalized;
      return [];
    case 'address':
      tags['addr:full'] = normalized;
      delete tags['addr:full:en'];
      return ['addr:full:en'];
    case 'description':
      tags.description = normalized;
      return [];
    default:
      return [];
  }
}

function buildDesiredTagMap(currentTags: LooseRecord, candidateRows) {
  const latestRow = candidateRows[0] || {};
  const desired = cloneTagMap(currentTags || {});
  const localState = stateFromLocalRow(latestRow);
  const explicitFields = new Set();
  const removedKeys = new Set();
  for (const row of candidateRows) {
    for (const field of parseEditedFields(row.edited_fields_json)) {
      explicitFields.add(field);
    }
  }

  for (const field of Object.keys(localState)) {
    const fieldRemovedKeys = applyFieldToTagMap(desired, field, localState[field], explicitFields.has(field));
    if (Array.isArray(fieldRemovedKeys)) {
      for (const key of fieldRemovedKeys) removedKeys.add(key);
    }
  }

  for (const key of Object.keys(desired)) {
    if (desired[key] == null || String(desired[key]).trim() === '') {
      delete desired[key];
    }
  }

  return { desired: desired as LooseRecord, localState: localState as LooseRecord, explicitFields: [...explicitFields] as string[], removedKeys: [...removedKeys] as string[] };
}

function parseOsmElementResponse(xmlText) {
  const xml = String(xmlText || '').trim();
  const elementMatch = xml.match(/<\s*(node|way|relation)\b[\s\S]*?<\/\s*\1\s*>/i)
    || xml.match(/<\s*(node|way|relation)\b[^>]*\/>/i);
  if (!elementMatch) {
    throw new Error('Unexpected OSM element response');
  }
  const fragment = elementMatch[0];
  if (/\/>\s*$/.test(fragment)) {
    const header = fragment.replace(/^<\s*(node|way|relation)\b/i, '').replace(/\/>\s*$/, '');
    const type = String((fragment.match(/^<\s*(node|way|relation)\b/i) || [])[1] || '').toLowerCase();
    return {
      type,
      attrs: attrsToObject(header),
      beforeTags: '',
      tags: {},
      rawXml: fragment
    };
  }
  return parseElementXml(fragment);
}

export type { LooseOsmError };

export {
  DEFAULT_AUTH_BASE_URL,
  DEFAULT_API_BASE_URL,
  DEFAULT_SCOPE,
  DEFAULT_CHANGESET_SOURCE,
  DEFAULT_CHANGESET_CREATED_BY,
  makeOsmError,
  normalizeText,
  normalizeBaseUrl,
  isMasterOsmAuthBaseUrl,
  normalizeAuthBaseUrl,
  normalizeApiBaseUrl,
  normalizeRedirectUri,
  encryptSecret,
  decryptSecret,
  createPkceChallenge,
  stableJson,
  parseJson,
  tagsFingerprint,
  parseTags,
  escapeXml,
  unescapeXml,
  attrsToObject,
  attrsToString,
  parseElementXml,
  parseGeneralSettingsRow,
  parseSyncSummary,
  cloneTagMap,
  normalizeStateValue,
  normalizeMaterialValue,
  stateFromLocalRow,
  stateFromContourTags,
  diffStates,
  parseEditedFields,
  controlledKeysForField,
  applyFieldToTagMap,
  buildDesiredTagMap,
  parseOsmElementResponse
};
