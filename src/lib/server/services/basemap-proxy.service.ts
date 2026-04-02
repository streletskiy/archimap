const { Readable } = require('node:stream');
const {
  CUSTOM_BASEMAP_TILE_PROXY_URL,
  CUSTOM_BASEMAP_TILEJSON_PROXY_URL,
  buildBasemapSourceUrl,
  normalizeBasemapApiKey,
  normalizeCustomBasemapUrl
} = require('./basemap-config');

function cloneJson(value) {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function resolveTemplateUrl(template, baseUrl) {
  const text = String(template || '').trim();
  if (!text) return '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return text;

  const base = new URL(String(baseUrl || '').trim());
  if (text.startsWith('//')) {
    return `${base.protocol}${text}`;
  }
  if (text.startsWith('/')) {
    return `${base.protocol}//${base.host}${text}`;
  }

  const basePath = base.pathname.endsWith('/')
    ? base.pathname
    : base.pathname.replace(/\/[^/]*$/, '/');
  return `${base.protocol}//${base.host}${basePath}${text}`;
}

function appendQueryParamToTemplateUrl(url, name, value) {
  const text = String(url || '').trim();
  if (!text) return text;

  const hashIndex = text.indexOf('#');
  const hash = hashIndex >= 0 ? text.slice(hashIndex) : '';
  const beforeHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  const queryIndex = beforeHash.indexOf('?');
  const base = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const query = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : '';
  if (query && new URLSearchParams(query).has(name)) {
    return text;
  }
  const nextQuery = query
    ? `${query}&${name}=${encodeURIComponent(String(value || ''))}`
    : `${name}=${encodeURIComponent(String(value || ''))}`;
  return `${base}?${nextQuery}${hash}`;
}

function buildFetchCandidates(url) {
  const text = String(url || '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return [text];
  }

  const candidates = [parsed.toString()];
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!loopbackHosts.has(parsed.hostname)) {
    return candidates;
  }

  for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal', 'host.containers.internal']) {
    try {
      const alternate = new URL(parsed.toString());
      alternate.hostname = hostname;
      const candidate = alternate.toString();
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    } catch {
      // ignore malformed fallback candidates
    }
  }

  return candidates;
}

async function fetchWithLocalhostFallback(url, init) {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Fetch is not available');
  }

  const candidates = buildFetchCandidates(url);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      return await globalThis.fetch(candidate, init);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Fetch failed');
}

function buildCustomBasemapTileProxyUrl(templateUrl, baseOrigin = '') {
  const path = `${CUSTOM_BASEMAP_TILE_PROXY_URL}?u=${encodeURIComponent(String(templateUrl || '').trim())}&z={z}&x={x}&y={y}`;
  const origin = String(baseOrigin || '').trim().replace(/\/+$/, '');
  return origin ? `${origin}${path}` : path;
}

function rewriteCustomBasemapTileJson(tilejson, upstreamTileJsonUrl, apiKey, baseOrigin = '') {
  const next = cloneJson(tilejson);
  const upstreamTiles = Array.isArray(next?.tiles) ? next.tiles : [];
  if (upstreamTiles.length > 0) {
    next.tiles = upstreamTiles.map((template) => {
      const absoluteTemplate = resolveTemplateUrl(template, upstreamTileJsonUrl);
      const keyedTemplate = apiKey
        ? appendQueryParamToTemplateUrl(absoluteTemplate, 'key', apiKey)
        : absoluteTemplate;
      return buildCustomBasemapTileProxyUrl(keyedTemplate, baseOrigin);
    });
  }
  if (next && typeof next === 'object') {
    delete next.url;
    delete next.tilejson;
  }
  return next;
}

async function fetchRemoteJson(url, { accept = 'application/json' } = {}) {
  const response = await fetchWithLocalhostFallback(url, {
    headers: {
      Accept: accept
    }
  });
  if (!response?.ok) {
    const error = new Error(`Request failed with status ${Number(response?.status) || 0}`);
    error.status = Number(response?.status) || 502;
    throw error;
  }
  return response.json();
}

function copyProxyHeaders(upstreamResponse, res, { skipCacheControl = false } = {}) {
  const headerNames = [
    'content-type',
    'content-disposition',
    'cache-control',
    'etag',
    'last-modified',
    'expires',
    'accept-ranges'
  ];
  for (const headerName of headerNames) {
    if (skipCacheControl && headerName === 'cache-control') continue;
    const value = upstreamResponse.headers.get(headerName);
    if (value) {
      res.setHeader(headerName, value);
    }
  }
}

async function sendProxiedBinaryResponse(req, res, upstreamUrl, { accept = '*/*', cacheControl = null } = {}) {
  const response = await fetchWithLocalhostFallback(upstreamUrl, {
    headers: {
      Accept: accept
    }
  });

  if (!response?.ok) {
    return res.status(Number(response?.status) || 502).type('text/plain').send(`Upstream request failed with status ${Number(response?.status) || 0}`);
  }

  copyProxyHeaders(response, res, { skipCacheControl: Boolean(cacheControl) });
  if (cacheControl) {
    res.setHeader('Cache-Control', cacheControl);
  }
  res.status(Number(response.status) || 200);

  if (req.method === 'HEAD') {
    return res.end();
  }

  if (!response.body) {
    return res.end();
  }

  const bodyStream = Readable.fromWeb(response.body);
  bodyStream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).type('text/plain').send('Failed to stream upstream response');
      return;
    }
    res.destroy();
  });
  bodyStream.pipe(res);
  return undefined;
}

function getCustomBasemapRouteConfig(raw: LooseRecord = {}) {
  const provider = raw.provider || raw.basemapProvider;
  const customBasemapUrl = normalizeCustomBasemapUrl(raw.customBasemapUrl || raw.custom_basemap_url, '');
  const customBasemapApiKey = normalizeBasemapApiKey(raw.customBasemapApiKey || raw.custom_basemap_api_key);
  return {
    provider,
    customBasemapUrl,
    customBasemapApiKey
  };
}

function resolveCustomBasemapSourceUrl(config) {
  return buildBasemapSourceUrl(config.customBasemapUrl, config.customBasemapApiKey);
}

module.exports = {
  CUSTOM_BASEMAP_TILEJSON_PROXY_URL,
  fetchRemoteJson,
  getCustomBasemapRouteConfig,
  resolveCustomBasemapSourceUrl,
  rewriteCustomBasemapTileJson,
  sendProxiedBinaryResponse
};
