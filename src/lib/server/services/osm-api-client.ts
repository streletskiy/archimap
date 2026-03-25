import { attrsToObject, parseOsmElementResponse } from './osm-sync.shared';

type LooseOsmClientDeps = {
  fetch?: typeof fetch;
};

async function fetchText(url, init: LooseRecord = {}, deps: LooseOsmClientDeps = {}) {
  const clientFetch = deps.fetch || fetch;
  const response = await clientFetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(text || `OSM request failed (${response.status})`) as LooseRecord;
    error.status = response.status;
    error.code = `OSM_HTTP_${response.status}`;
    throw error;
  }
  return text;
}

async function exchangeCodeForToken({ code, verifier, authBaseUrl, redirectUri, clientId, clientSecret }: LooseRecord, deps: LooseOsmClientDeps = {}) {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', String(code || ''));
  body.set('client_id', String(clientId || ''));
  body.set('redirect_uri', String(redirectUri || ''));
  body.set('code_verifier', String(verifier || ''));
  if (clientSecret) body.set('client_secret', String(clientSecret));
  const clientFetch = deps.fetch || fetch;
  const response = await clientFetch(new URL('/oauth2/token', authBaseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body
  });
  const text = await response.text();
  let payload: LooseRecord;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
  if (!response.ok) {
    const error = new Error(String(payload?.error_description || payload?.error || text || `OSM token exchange failed (${response.status})`)) as LooseRecord;
    error.status = response.status;
    error.code = payload?.error || `OSM_TOKEN_HTTP_${response.status}`;
    throw error;
  }
  return payload;
}

async function fetchOsmUserDetails(accessToken, apiBaseUrl, deps: LooseOsmClientDeps = {}) {
  try {
    const xml = await fetchText(new URL('/api/0.6/user/details', apiBaseUrl), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/xml, text/xml;q=0.9, */*;q=0.1' }
    }, deps);
    const match = String(xml || '').match(/<user\b([^>]*)>/i);
    if (!match) return null;
    const attrs: LooseRecord = attrsToObject(match[1]);
    return attrs.display_name || attrs.name || attrs.username || null;
  } catch {
    return null;
  }
}

async function fetchOsmElement(osmType, osmId, accessToken, apiBaseUrl, deps: LooseOsmClientDeps = {}) {
  const endpoint = new URL(`/api/0.6/${encodeURIComponent(osmType)}/${encodeURIComponent(osmId)}`, apiBaseUrl);
  const xml = await fetchText(endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/xml, text/xml;q=0.9, */*;q=0.1'
    }
  }, deps);
  return parseOsmElementResponse(xml);
}

export {
  fetchText,
  exchangeCodeForToken,
  fetchOsmUserDetails,
  fetchOsmElement
};
