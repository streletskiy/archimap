import { translateNow } from '$lib/i18n/index';

export function getUserInitials(user) {
  const parts = [String(user?.firstName || '').trim(), String(user?.lastName || '').trim()].filter(Boolean);
  if (parts.length > 0) {
    return parts.map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  }
  const email = String(user?.email || '').trim();
  return email ? email.slice(0, 2).toUpperCase() : 'AR';
}

export function getUserLabel(user, fallback = translateNow('common.appName')) {
  const fullName = [String(user?.firstName || '').trim(), String(user?.lastName || '').trim()].filter(Boolean).join(' ');
  return fullName || String(user?.email || '').trim() || fallback;
}
