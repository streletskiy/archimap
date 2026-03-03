import { get } from 'svelte/store';
import { session } from '$lib/stores/auth';
import { translateNow } from '$lib/i18n/index';

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
    const code = String(data?.code || '').trim();
    const codeMessage = code ? translateNow(`errors.codes.${code}`) : '';
    const errorMessage = String(
      (codeMessage && codeMessage !== `errors.codes.${code}` ? codeMessage : '')
      || data?.error
      || translateNow('errors.requestFailed', { status: resp.status })
    );
    throw new Error(errorMessage);
  }
  return data;
}

const getCache = new Map();

function normalizeCacheKey(input, init) {
  const method = String(init?.method || 'GET').toUpperCase();
  const url = typeof input === 'string' ? input : String(input?.url || '');
  return `${method}:${url}`;
}

export async function apiJsonCached(input, options = {}) {
  const ttlMs = Math.max(0, Number(options.ttlMs || 0));
  const cacheKey = options.cacheKey || normalizeCacheKey(input, options);
  const now = Date.now();
  const cached = getCache.get(cacheKey);
  if (cached && (now - cached.ts) <= ttlMs) {
    return cached.data;
  }

  const init = { ...options };
  delete init.ttlMs;
  delete init.cacheKey;
  const data = await apiJson(input, init);
  if (ttlMs > 0) {
    getCache.set(cacheKey, { ts: now, data });
    if (getCache.size > 200) {
      const oldestKey = getCache.keys().next().value;
      getCache.delete(oldestKey);
    }
  }
  return data;
}
