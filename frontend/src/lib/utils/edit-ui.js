export function formatUiDate(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : text;
}

export function getStatusBadgeMeta(status, translate) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'accepted') return { text: translate('admin.status.accepted'), cls: 'bg-emerald-100 text-emerald-700' };
  if (normalized === 'partially_accepted') return { text: translate('admin.status.partially_accepted'), cls: 'bg-slate-200 text-slate-800' };
  if (normalized === 'rejected') return { text: translate('admin.status.rejected'), cls: 'bg-rose-100 text-rose-700' };
  if (normalized === 'superseded') return { text: translate('admin.status.superseded'), cls: 'bg-slate-100 text-slate-700' };
  return { text: translate('admin.status.pending'), cls: 'bg-amber-100 text-amber-700' };
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

export function getEditAddress(item) {
  if (item?.values?.address) return String(item.values.address);
  if (item?.local?.address) return String(item.local.address);
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const addressChange = changes.find((change) => change?.field === 'address');
  if (addressChange?.localValue) return String(addressChange.localValue);
  if (addressChange?.osmValue) return String(addressChange.osmValue);
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
