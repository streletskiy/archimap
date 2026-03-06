function normalizeValue(normalizeText, value) {
  if (typeof normalizeText === 'function') return normalizeText(value);
  const text = String(value ?? '').trim();
  return text || '';
}

function firstNormalized(normalizeText, values) {
  for (const value of values) {
    const normalized = normalizeValue(normalizeText, value);
    if (normalized) return normalized;
  }
  return '';
}

function getAddressParts(source, normalizeText) {
  return {
    full: firstNormalized(normalizeText, [source?.['addr:full'], source?.addr_full]),
    postcode: firstNormalized(normalizeText, [source?.['addr:postcode'], source?.addr_postcode]),
    city: firstNormalized(normalizeText, [source?.['addr:city'], source?.addr_city]),
    place: firstNormalized(normalizeText, [source?.['addr:place'], source?.addr_place]),
    street: firstNormalized(normalizeText, [source?.['addr:street'], source?.addr_street, source?.addr_stree]),
    housenumber: firstNormalized(normalizeText, [source?.['addr:housenumber'], source?.addr_housenumber, source?.addr_hous])
  };
}

export function buildAddressText(fields, normalizeText) {
  const full = firstNormalized(normalizeText, [fields?.full]);
  if (full) return full;

  const parts = [
    firstNormalized(normalizeText, [fields?.postcode]),
    firstNormalized(normalizeText, [fields?.city]),
    firstNormalized(normalizeText, [fields?.place]),
    firstNormalized(normalizeText, [fields?.street])
  ].filter(Boolean);
  const house = firstNormalized(normalizeText, [fields?.housenumber, fields?.houseNumber]);

  if (house) {
    if (parts.length > 0) {
      parts[parts.length - 1] = `${parts[parts.length - 1]}, ${house}`;
    } else {
      parts.push(house);
    }
  }

  return parts.join(', ');
}

export function hasStructuredAddressParts(source, normalizeText) {
  const parts = getAddressParts(source, normalizeText);
  return Boolean(parts.postcode || parts.city || parts.place || parts.street || parts.housenumber);
}

export function parseAddressFields(source, normalizeText, { fallbackAddress = '', allowFallbackAsFull = true } = {}) {
  const parts = getAddressParts(source, normalizeText);
  return {
    full: firstNormalized(normalizeText, [
      parts.full,
      allowFallbackAsFull ? fallbackAddress : ''
    ]),
    postcode: parts.postcode,
    city: parts.city,
    place: parts.place,
    street: parts.street,
    housenumber: parts.housenumber
  };
}

export function resolveAddressText(source, normalizeText, fallbackAddress = '') {
  const parts = getAddressParts(source, normalizeText);
  return firstNormalized(normalizeText, [
    parts.full,
    fallbackAddress,
    buildAddressText(parts, normalizeText)
  ]);
}
