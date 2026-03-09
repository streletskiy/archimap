import {
  normalizeFilterColor,
  normalizeFilterLayers,
  normalizeFilterLayerMode
} from '../components/map/filter-pipeline-utils.js';

const FILTER_URL_VERSION = 2;
const VALUELESS_RULE_OPS = new Set(['exists', 'not_exists']);

const MODE_TO_BYTE = Object.freeze({
  and: 0,
  or: 1,
  layer: 2
});

const BYTE_TO_MODE = Object.freeze({
  0: 'and',
  1: 'or',
  2: 'layer'
});

const OP_TO_BYTE = Object.freeze({
  contains: 0,
  equals: 1,
  not_equals: 2,
  starts_with: 3,
  exists: 4,
  not_exists: 5,
  greater_than: 6,
  greater_or_equals: 7,
  less_than: 8,
  less_or_equals: 9
});

const BYTE_TO_OP = Object.freeze(Object.fromEntries(
  Object.entries(OP_TO_BYTE).map(([op, byte]) => [String(byte), op])
));

function toBase64Url(base64) {
  return String(base64 || '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(text) {
  const normalized = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return `${normalized}${padding}`;
}

function encodeBase64UrlBytes(bytes) {
  const normalizedBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (typeof Buffer !== 'undefined') {
    return toBase64Url(Buffer.from(normalizedBytes).toString('base64'));
  }
  let binary = '';
  for (const byte of normalizedBytes) {
    binary += String.fromCharCode(byte);
  }
  return toBase64Url(btoa(binary));
}

function decodeBase64UrlBytes(text) {
  const base64 = fromBase64Url(text);
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeUtf8(text) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(String(text || ''));
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(String(text || ''), 'utf8'));
  }
  const encoded = unescape(encodeURIComponent(String(text || '')));
  const bytes = new Uint8Array(encoded.length);
  for (let index = 0; index < encoded.length; index += 1) {
    bytes[index] = encoded.charCodeAt(index);
  }
  return bytes;
}

function decodeUtf8(bytes) {
  const normalizedBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(normalizedBytes);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(normalizedBytes).toString('utf8');
  }
  let binary = '';
  for (const byte of normalizedBytes) {
    binary += String.fromCharCode(byte);
  }
  return decodeURIComponent(escape(binary));
}

function appendVarint(output, rawValue) {
  let value = Math.max(0, Number(rawValue) || 0);
  while (value >= 0x80) {
    output.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 0x80);
  }
  output.push(value & 0x7f);
}

function readVarint(bytes, startOffset) {
  let offset = Number(startOffset) || 0;
  let value = 0;
  let shift = 0;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) {
      return {
        value,
        nextOffset: offset
      };
    }
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

function colorToBytes(color) {
  const normalized = normalizeFilterColor(color);
  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16)
  ];
}

function colorFromBytes(red, green, blue) {
  const toHex = (value) => Number(value).toString(16).padStart(2, '0');
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function toSerializableLayers(rawLayers) {
  const normalized = normalizeFilterLayers(rawLayers);
  if (normalized.invalidReason || normalized.layers.length === 0) return [];
  return normalized.layers.map((layer) => ({
    color: normalizeFilterColor(layer.color),
    mode: normalizeFilterLayerMode(layer.mode),
    rules: (Array.isArray(layer.rules) ? layer.rules : []).map((rule) => ({
      key: String(rule?.key || '').trim(),
      op: String(rule?.op || 'contains').trim(),
      value: String(rule?.value || '').trim()
    }))
  }));
}

function encodeFilterLayersBinary(rawLayers) {
  const layers = toSerializableLayers(rawLayers);
  if (layers.length === 0) return '';
  const keys = [];
  const keyIndexes = new Map();
  for (const layer of layers) {
    for (const rule of layer.rules) {
      const key = String(rule.key || '');
      if (!keyIndexes.has(key)) {
        keyIndexes.set(key, keys.length);
        keys.push(key);
      }
    }
  }

  const output = [FILTER_URL_VERSION];
  appendVarint(output, keys.length);
  for (const key of keys) {
    const keyBytes = encodeUtf8(key);
    appendVarint(output, keyBytes.length);
    output.push(...keyBytes);
  }

  appendVarint(output, layers.length);
  for (const layer of layers) {
    output.push(MODE_TO_BYTE[layer.mode] ?? MODE_TO_BYTE.and);
    output.push(...colorToBytes(layer.color));
    appendVarint(output, layer.rules.length);
    for (const rule of layer.rules) {
      appendVarint(output, keyIndexes.get(rule.key) ?? 0);
      output.push(OP_TO_BYTE[rule.op] ?? OP_TO_BYTE.contains);
      if (VALUELESS_RULE_OPS.has(rule.op)) continue;
      const valueBytes = encodeUtf8(rule.value);
      appendVarint(output, valueBytes.length);
      output.push(...valueBytes);
    }
  }

  return encodeBase64UrlBytes(new Uint8Array(output));
}

function decodeFilterLayersBinary(rawValue) {
  try {
    const bytes = decodeBase64UrlBytes(rawValue);
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
    if (bytes[0] !== FILTER_URL_VERSION) return null;

    let offset = 1;
    const keyCountState = readVarint(bytes, offset);
    if (!keyCountState) return null;
    offset = keyCountState.nextOffset;
    const keys = [];
    for (let index = 0; index < keyCountState.value; index += 1) {
      const keyLengthState = readVarint(bytes, offset);
      if (!keyLengthState) return null;
      offset = keyLengthState.nextOffset;
      const keyLength = Number(keyLengthState.value || 0);
      const nextOffset = offset + keyLength;
      if (nextOffset > bytes.length) return null;
      keys.push(decodeUtf8(bytes.slice(offset, nextOffset)));
      offset = nextOffset;
    }

    const layerCountState = readVarint(bytes, offset);
    if (!layerCountState) return null;
    offset = layerCountState.nextOffset;
    const decodedLayers = [];
    for (let priority = 0; priority < layerCountState.value; priority += 1) {
      if ((offset + 4) > bytes.length) return null;
      const mode = BYTE_TO_MODE[String(bytes[offset++])];
      const color = colorFromBytes(bytes[offset++], bytes[offset++], bytes[offset++]);
      const ruleCountState = readVarint(bytes, offset);
      if (!ruleCountState) return null;
      offset = ruleCountState.nextOffset;
      const rules = [];
      for (let ruleIndex = 0; ruleIndex < ruleCountState.value; ruleIndex += 1) {
        const keyIndexState = readVarint(bytes, offset);
        if (!keyIndexState) return null;
        offset = keyIndexState.nextOffset;
        if (offset >= bytes.length) return null;
        const op = BYTE_TO_OP[String(bytes[offset++])];
        const key = keys[keyIndexState.value];
        if (!key || !op) return null;
        if (VALUELESS_RULE_OPS.has(op)) {
          rules.push({ key, op, value: '' });
          continue;
        }
        const valueLengthState = readVarint(bytes, offset);
        if (!valueLengthState) return null;
        offset = valueLengthState.nextOffset;
        const valueLength = Number(valueLengthState.value || 0);
        const nextOffset = offset + valueLength;
        if (nextOffset > bytes.length) return null;
        rules.push({
          key,
          op,
          value: decodeUtf8(bytes.slice(offset, nextOffset))
        });
        offset = nextOffset;
      }
      decodedLayers.push({
        priority,
        mode,
        color,
        rules
      });
    }

    if (offset !== bytes.length) return null;
    const normalized = normalizeFilterLayers(decodedLayers);
    if (normalized.invalidReason || normalized.layers.length === 0) return null;
    return normalized.layers.map((layer, priority) => ({
      priority,
      mode: layer.mode,
      color: layer.color,
      rules: layer.rules.map((rule) => ({
        key: rule.key,
        op: rule.op,
        value: rule.value
      }))
    }));
  } catch {
    return null;
  }
}

export function encodeFilterLayersForUrl(rawLayers) {
  return encodeFilterLayersBinary(rawLayers);
}

export function decodeFilterLayersFromUrl(rawValue) {
  const encoded = String(rawValue || '').trim();
  if (!encoded) return null;
  return decodeFilterLayersBinary(encoded);
}

export function getFilterLayersUrlSignature(rawLayers) {
  return encodeFilterLayersForUrl(rawLayers);
}
