import { get } from 'svelte/store';
import { session } from '$lib/stores/auth';

function isStateChangingMethod(method) {
  const m = String(method || 'GET').toUpperCase();
  return !['GET', 'HEAD', 'OPTIONS'].includes(m);
}

export async function apiFetch(input, init = {}) {
  const nextInit = { ...init };
  const method = String(nextInit.method || 'GET').toUpperCase();
  if (isStateChangingMethod(method)) {
    const csrfToken = get(session)?.csrfToken || null;
    if (csrfToken) {
      const headers = new Headers(nextInit.headers || {});
      if (!headers.has('x-csrf-token')) {
        headers.set('x-csrf-token', csrfToken);
      }
      nextInit.headers = headers;
    }
  }
  return fetch(input, nextInit);
}

export async function apiJson(input, init = {}) {
  const resp = await apiFetch(input, init);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const errorMessage = String(data?.error || `Request failed: ${resp.status}`);
    throw new Error(errorMessage);
  }
  return data;
}
