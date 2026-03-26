export function formatUiDate(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : text;
}

export function resolveUiLocaleTag(locale) {
  const normalized = String(locale || '').trim().toLowerCase();
  return normalized.startsWith('ru') ? 'ru-RU' : 'en-US';
}

export function formatUiDateRangeLabel(range, locale = 'en-US') {
  const start = range?.start?.toString?.() || '';
  if (!start) return '';

  const end = range?.end?.toString?.() || start;
  const formatter = new Intl.DateTimeFormat(resolveUiLocaleTag(locale), {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });

  const formatIsoDate = (isoDate) => {
    const date = new Date(`${String(isoDate).slice(0, 10)}T00:00:00`);
    return Number.isFinite(date.getTime()) ? formatter.format(date) : String(isoDate);
  };

  if (start === end) {
    return formatIsoDate(start);
  }

  return `${formatIsoDate(start)} - ${formatIsoDate(end)}`;
}

export function matchesUiDateRange(value, range) {
  const start = range?.start?.toString?.() || '';
  if (!start) return true;

  const end = range?.end?.toString?.() || start;
  const isoDate = String(value || '').trim().slice(0, 10);
  if (!isoDate) return false;

  return isoDate >= start && isoDate <= end;
}

export function getStatusBadgeMeta(status, translate) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'accepted') return { text: translate('admin.status.accepted'), cls: 'ui-surface-success ui-text-success' };
  if (normalized === 'partially_accepted') return { text: translate('admin.status.partially_accepted'), cls: 'ui-surface-emphasis ui-text-emphasis' };
  if (normalized === 'rejected') return { text: translate('admin.status.rejected'), cls: 'ui-surface-danger ui-text-danger' };
  if (normalized === 'superseded') return { text: translate('admin.status.superseded'), cls: 'ui-surface-soft ui-text-body' };
  return { text: translate('admin.status.pending'), cls: 'ui-surface-warning ui-text-warning' };
}

export function getEditKey(item) {
  const osmType = String(item?.osmType || '').trim();
  const osmId = Number(item?.osmId || 0);
  return ['way', 'relation'].includes(osmType) && Number.isInteger(osmId) && osmId > 0
    ? `${osmType}/${osmId}`
    : null;
}

export function parseEditKey(key) {
  const [osmType, osmIdRaw] = String(key || '').split('/');
  const osmId = Number(osmIdRaw);
  return ['way', 'relation'].includes(osmType) && Number.isInteger(osmId) && osmId > 0
    ? { osmType, osmId }
    : null;
}

function getAddressFromTags(tags) {
  if (!tags || typeof tags !== 'object') return '';
  const pick = (...keys) => {
    for (const key of keys) {
      const value = String(tags?.[key] || '').trim();
      if (value) return value;
    }
    return '';
  };

  const full = pick('addr:full', 'addr:full:en');
  if (full) return full;

  const parts = [
    pick('addr:postcode', 'addr_postcode'),
    pick('addr:city', 'addr_city'),
    pick('addr:place', 'addr_place'),
    pick('addr:street', 'addr_street', 'addr_stree')
  ].filter(Boolean);
  const house = pick('addr:housenumber', 'addr_housenumber', 'addr_hous');
  if (house) {
    if (parts.length > 0) {
      parts[parts.length - 1] = `${parts[parts.length - 1]}, ${house}`;
    } else {
      parts.push(house);
    }
  }
  return parts.join(', ');
}

export function getEditAddress(item) {
  const displayAddress = String(item?.displayAddress || '').trim();
  if (displayAddress) return displayAddress;
  const mergedAddress = String(item?.latestMerged?.address || '').trim();
  if (mergedAddress) return mergedAddress;
  const valueAddress = String(item?.values?.address || '').trim();
  if (valueAddress) return valueAddress;
  const localAddress = String(item?.local?.address || '').trim();
  if (localAddress) return localAddress;
  const currentTagAddress = getAddressFromTags(item?.currentTags);
  if (currentTagAddress) return currentTagAddress;
  const sourceTagAddress = getAddressFromTags(item?.sourceTags);
  if (sourceTagAddress) return sourceTagAddress;
  const genericTagAddress = getAddressFromTags(item?.tags);
  if (genericTagAddress) return genericTagAddress;
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const addressChange = changes.find((change) => change?.field === 'address');
  const localValue = String(addressChange?.localValue || '').trim();
  if (localValue) return localValue;
  const osmValue = String(addressChange?.osmValue || '').trim();
  if (osmValue) return osmValue;
  return `${String(item?.osmType || '')}/${Number(item?.osmId || 0)}`;
}

export function getChangeCounters(changes) {
  const list = Array.isArray(changes) ? changes : [];
  let created = 0;
  let modified = 0;
  for (const change of list) {
    if (change?.osmValue == null && change?.localValue != null) created += 1;
    else modified += 1;
  }
  return { total: list.length, created, modified };
}
