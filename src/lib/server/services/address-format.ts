type AddressRowLike = {
  address?: unknown;
  tags_json?: unknown;
  source_tags_json?: unknown;
};

type AddressTagMap = Record<string, unknown>;

function normalizeText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function parseTags(raw: unknown): AddressTagMap {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as AddressTagMap;
  }
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AddressTagMap) : {};
  } catch {
    return {};
  }
}

function pickTagValue(tags: AddressTagMap, keys: string[]): string | null {
  for (const key of keys) {
    const value = normalizeText(tags?.[key]);
    if (value != null) return value;
  }
  return null;
}

export function osmAddressFromTags(tags: AddressTagMap = {}): string | null {
  const full = pickTagValue(tags, ['addr:full', 'addr:full:en']);
  if (full != null) return full;

  const parts = [
    pickTagValue(tags, ['addr:postcode', 'addr_postcode']),
    pickTagValue(tags, ['addr:city', 'addr_city']),
    pickTagValue(tags, ['addr:place', 'addr_place']),
    pickTagValue(tags, ['addr:street', 'addr_street', 'addr_stree'])
  ].filter((value): value is string => value != null);

  const house = pickTagValue(tags, ['addr:housenumber', 'addr_housenumber', 'addr_hous']);
  if (house != null) {
    if (parts.length > 0) {
      parts[parts.length - 1] = `${parts[parts.length - 1]}, ${house}`;
    } else {
      parts.push(house);
    }
  }

  const text = parts.join(', ');
  return text ? text : null;
}

export function resolveDisplayAddressForRow(row: AddressRowLike = {}, mergedInfoRow: { address?: unknown } | null = null): string | null {
  const mergedAddress = normalizeText(mergedInfoRow?.address);
  if (mergedAddress != null) return mergedAddress;

  const rowAddress = normalizeText(row?.address);
  if (rowAddress != null) return rowAddress;

  const currentContourAddress = osmAddressFromTags(parseTags(row?.tags_json));
  if (currentContourAddress != null) return currentContourAddress;

  const sourceContourAddress = osmAddressFromTags(parseTags(row?.source_tags_json));
  if (sourceContourAddress != null) return sourceContourAddress;

  return null;
}
