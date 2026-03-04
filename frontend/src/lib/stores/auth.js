import { writable } from 'svelte/store';

export const session = writable({
  loading: true,
  authenticated: false,
  csrfToken: null,
  user: null
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
