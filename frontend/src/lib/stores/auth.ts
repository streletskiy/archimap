import { writable } from 'svelte/store';
import { invalidateBuildingData } from './building-data';

export const session = writable({
  loading: true,
  authenticated: false,
  csrfToken: null,
  user: null
});

let sessionIdentity = '';
session.subscribe((value) => {
  const identity = value.authenticated ? String(value.user?.id ?? value.user?.email ?? 'authenticated') : '';
  if (identity !== sessionIdentity) {
    sessionIdentity = identity;
    invalidateBuildingData();
  }
});

export function setSession(payload) {
  session.set({
    loading: false,
    authenticated: Boolean(payload?.authenticated),
    csrfToken: payload?.csrfToken ? String(payload.csrfToken) : null,
    user: payload?.user || null
  });
}

export function clearSession() {
  session.set({
    loading: false,
    authenticated: false,
    csrfToken: null,
    user: null
  });
}
