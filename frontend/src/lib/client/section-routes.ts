function toUrl(input) {
  return input instanceof URL ? input : new URL(String(input || ''), 'http://localhost');
}

function normalizePathname(pathname) {
  const raw = String(pathname || '').trim() || '/';
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  if (withLeadingSlash.length === 1) return withLeadingSlash;
  return withLeadingSlash.replace(/\/+$/, '');
}

export function getSectionBasePrefix(pathname = '/') {
  const normalized = normalizePathname(pathname);
  if (normalized === '/app' || normalized.startsWith('/app/')) return '/app';
  return '';
}

function stripSectionBasePrefix(pathname = '/') {
  const normalized = normalizePathname(pathname);
  const basePrefix = getSectionBasePrefix(normalized);
  if (!basePrefix) return normalized;
  const stripped = normalized.slice(basePrefix.length);
  return stripped || '/';
}

function getSectionChild(pathname, sectionName) {
  const normalized = stripSectionBasePrefix(pathname);
  const sectionRoot = `/${sectionName}`;
  if (normalized === sectionRoot) return '';
  if (!normalized.startsWith(`${sectionRoot}/`)) return null;
  return normalized.slice(sectionRoot.length + 1);
}

function parseLegacyInfoTab(searchParams) {
  const tabRaw = String(searchParams.get('tab') || searchParams.get('info') || '').trim().toLowerCase();
  const docRaw = String(searchParams.get('doc') || searchParams.get('section') || '').trim().toLowerCase();

  if (tabRaw === 'privacy-policy') return 'privacy';
  if (tabRaw === 'user-agreement') return 'agreement';
  if (tabRaw === 'about' || tabRaw === 'overview') return 'about';

  if (tabRaw === 'legal') {
    if (docRaw === 'privacy') return 'privacy';
    return 'agreement';
  }

  if (!tabRaw && docRaw) {
    if (docRaw === 'privacy') return 'privacy';
    return 'agreement';
  }

  return 'about';
}

function parseLegacyAccountTab(searchParams) {
  if (searchParams.has('editId') || searchParams.has('edit')) return 'edits';
  const tabRaw = String(searchParams.get('tab') || searchParams.get('section') || '').trim().toLowerCase();
  if (tabRaw === 'edits' || tabRaw === 'history') return 'edits';
  return 'settings';
}

function parseLegacyAdminTab(searchParams) {
  const tabRaw = String(searchParams.get('tab') || searchParams.get('section') || '').trim().toLowerCase();
  if (searchParams.has('edit') || searchParams.has('adminEdit')) return 'edits';
  if (tabRaw === 'users') return 'users';
  if (tabRaw === 'data') return 'data';
  if (tabRaw === 'styles') return 'styles';
  if (tabRaw === 'settings') return 'settings';
  return 'edits';
}

function buildSectionPath(pathname, sectionName, slug) {
  const basePrefix = getSectionBasePrefix(pathname);
  return `${basePrefix}/${sectionName}/${slug}`;
}

export function resolveInfoTabFromUrl(input) {
  const url = toUrl(input);
  const child = getSectionChild(url.pathname, 'info');
  if (child != null && child !== '') {
    const slug = String(child.split('/')[0] || '').trim().toLowerCase();
    if (slug === 'terms' || slug === 'agreement') return 'agreement';
    if (slug === 'privacy') return 'privacy';
    return 'about';
  }
  return parseLegacyInfoTab(url.searchParams);
}

export function resolveAccountTabFromUrl(input) {
  const url = toUrl(input);
  const child = getSectionChild(url.pathname, 'account');
  if (child != null && child !== '') {
    const slug = String(child.split('/')[0] || '').trim().toLowerCase();
    if (slug === 'edits' || slug === 'history') return 'edits';
    return 'settings';
  }
  return parseLegacyAccountTab(url.searchParams);
}

export function resolveAccountEditIdFromUrl(input) {
  const url = toUrl(input);
  const editId = Number(url.searchParams.get('editId'));
  if (!Number.isInteger(editId) || editId <= 0) return null;
  return editId;
}

export function resolveAdminTabFromUrl(input) {
  const url = toUrl(input);
  if (url.searchParams.has('edit') || url.searchParams.has('adminEdit')) return 'edits';
  const child = getSectionChild(url.pathname, 'admin');
  if (child != null && child !== '') {
    const slug = String(child.split('/')[0] || '').trim().toLowerCase();
    if (slug === 'users') return 'users';
    if (slug === 'data') return 'data';
    if (slug === 'osm') return 'osm';
    if (slug === 'filters') return 'filters';
    if (slug === 'styles') return 'styles';
    if (slug === 'settings') return 'settings';
    return 'edits';
  }
  return parseLegacyAdminTab(url.searchParams);
}

export function buildInfoUrl(input, tab) {
  const current = toUrl(input);
  const next = new URL(current.toString());
  const slug = tab === 'privacy' ? 'privacy' : tab === 'agreement' ? 'terms' : 'about';
  next.pathname = buildSectionPath(current.pathname, 'info', slug);
  next.searchParams.delete('tab');
  next.searchParams.delete('doc');
  next.searchParams.delete('info');
  next.searchParams.delete('section');
  return next;
}

export function buildAccountUrl(input, tab) {
  const current = toUrl(input);
  const next = new URL(current.toString());
  const slug = tab === 'edits' ? 'edits' : 'settings';
  next.pathname = buildSectionPath(current.pathname, 'account', slug);
  next.searchParams.delete('tab');
  next.searchParams.delete('section');
  return next;
}

export function buildAccountEditUrl(input, editId) {
  const current = toUrl(input);
  const next = buildAccountUrl(current, 'edits');
  const normalizedEditId = Number(editId);
  if (Number.isInteger(normalizedEditId) && normalizedEditId > 0) {
    next.searchParams.set('editId', String(normalizedEditId));
  } else {
    next.searchParams.delete('editId');
  }
  return next;
}

export function buildAdminUrl(input, tab) {
  const current = toUrl(input);
  const next = new URL(current.toString());
  const slug = tab === 'users' || tab === 'data' || tab === 'osm' || tab === 'filters' || tab === 'styles' || tab === 'settings' ? tab : 'edits';
  next.pathname = buildSectionPath(current.pathname, 'admin', slug);
  next.searchParams.delete('tab');
  next.searchParams.delete('section');
  return next;
}
