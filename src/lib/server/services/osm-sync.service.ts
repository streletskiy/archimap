const crypto = require('crypto');

const DEFAULT_AUTH_BASE_URL = 'https://www.openstreetmap.org';
const DEFAULT_API_BASE_URL = 'https://api.openstreetmap.org';
const DEFAULT_SCOPE = 'write_api write_changeset_comments';
const DEFAULT_CHANGESET_SOURCE = 'ArchiMap local architectural edits';
const DEFAULT_CHANGESET_CREATED_BY = 'ArchiMap OSM sync';

type LooseOsmError = Error & {
  status?: number;
  code?: string;
  details?: LooseRecord | null;
};

function createOsmSyncService(options: LooseRecord = {}) {
  const { db, settingsSecret, appSettingsService, enqueueSearchIndexRefresh, refreshDesignRefSuggestionsCache } = options;
  if (!db) throw new Error('createOsmSyncService: db is required');
  const secret = String(settingsSecret || '').trim();
  if (!secret) throw new Error('createOsmSyncService: settingsSecret is required');

  const secretKey = crypto.scryptSync(secret, 'archimap:osm-sync-service', 32);

  function normalizeText(value, maxLength = 255) {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, Math.max(1, maxLength)) : null;
  }

  function makeOsmError(message, { status = 500, code = null, details = null } = {}) {
    const error = new Error(String(message || 'OSM sync error')) as LooseOsmError;
    error.status = status;
    if (code) {
      error.code = code;
    }
    if (details) {
      error.details = details;
    }
    return error;
  }

  function normalizeBaseUrl(value, fallback) {
    const text = String(value || '').trim();
    if (!text) return fallback;
    try {
      const url = new URL(text);
      url.pathname = url.pathname.replace(/\/+$/, '');
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/+$/, '');
    } catch {
      return fallback;
    }
  }

  function isMasterOsmAuthBaseUrl(value) {
    const normalized = normalizeBaseUrl(value, '');
    if (!normalized) return false;
    try {
      return new URL(normalized).hostname === 'master.apis.dev.openstreetmap.org';
    } catch {
      return false;
    }
  }

  function normalizeAuthBaseUrl(value) {
    return normalizeBaseUrl(value, DEFAULT_AUTH_BASE_URL) || DEFAULT_AUTH_BASE_URL;
  }

  function normalizeApiBaseUrl(value, authBaseUrl = DEFAULT_AUTH_BASE_URL) {
    const explicit = normalizeBaseUrl(value, '');
    if (explicit) return explicit;
    return isMasterOsmAuthBaseUrl(authBaseUrl)
      ? 'https://master.apis.dev.openstreetmap.org'
      : DEFAULT_API_BASE_URL;
  }

  function normalizeRedirectUri(value, baseUrl) {
    const explicit = String(value || '').trim();
    if (explicit) {
      try {
        const url = new URL(explicit);
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/+$/, '');
      } catch {
        return null;
      }
    }
    const base = String(baseUrl || '').trim();
    if (!base) return null;
    try {
      return new URL('/api/admin/app-settings/osm/oauth/callback', base).toString().replace(/\/+$/, '');
    } catch {
      return null;
    }
  }

  function encryptSecret(plaintext) {
    const value = String(plaintext || '');
    if (!value) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
  }

  function decryptSecret(encoded) {
    const value = String(encoded || '').trim();
    if (!value) return '';
    const parts = value.split('.');
    if (parts.length !== 3) return '';
    try {
      const iv = Buffer.from(parts[0], 'base64');
      const tag = Buffer.from(parts[1], 'base64');
      const encrypted = Buffer.from(parts[2], 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  async function createPkceChallenge(verifier) {
    const verifierBytes = Buffer.from(String(verifier || ''), 'utf8');
    const subtle = crypto.webcrypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest('SHA-256', verifierBytes);
      return Buffer.from(digest).toString('base64url');
    }
    return crypto.createHash('sha256').update(verifierBytes).digest('base64url');
  }

  function stableJson(value) {
    if (Array.isArray(value)) return value.map((item) => stableJson(item));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableJson(value[key]);
    return out;
  }

  function parseJson(raw, fallback = null) {
    if (raw == null || String(raw).trim() === '') return fallback;
    try {
      return JSON.parse(String(raw));
    } catch {
      return fallback;
    }
  }

  function tagsFingerprint(raw) {
    const parsed = parseJson(raw, {});
    return JSON.stringify(stableJson(parsed && typeof parsed === 'object' ? parsed : {}));
  }

  function parseTags(raw) {
    const parsed = parseJson(raw, {});
    return parsed && typeof parsed === 'object' ? parsed : {};
  }

  function escapeXml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function unescapeXml(value) {
    return String(value || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function attrsToObject(text = '') {
    const attrs = {};
    const re = /([A-Za-z_][A-Za-z0-9_.:-]*)="([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(String(text || '')))) attrs[String(match[1])] = unescapeXml(match[2]);
    return attrs;
  }

  function attrsToString(attrs: LooseRecord = {}) {
    return Object.keys(attrs)
      .filter((key) => attrs[key] != null)
      .map((key) => `${key}="${escapeXml(attrs[key])}"`)
      .join(' ');
  }

  function parseElementXml(xmlText) {
    const text = String(xmlText || '').trim();
    const match = text.match(/<\s*(node|way|relation)\b([^>]*)>([\s\S]*)<\/\s*\1\s*>/i);
    if (!match) throw new Error('Unexpected OSM element XML');
    const type = String(match[1]).trim().toLowerCase();
    const attrs = attrsToObject(match[2]);
    const inner = String(match[3] || '');
    const tagIndex = inner.indexOf('<tag ');
    const beforeTags = tagIndex >= 0 ? inner.slice(0, tagIndex).trimEnd() : inner.trimEnd();
    const tags = {};
    for (const tagMatch of inner.matchAll(/<tag\s+k="([^"]*)"\s+v="([^"]*)"\s*\/>/g)) {
      const key = unescapeXml(tagMatch[1]);
      if (key) tags[key] = unescapeXml(tagMatch[2]);
    }
    return { type, attrs, beforeTags, tags, rawXml: text };
  }

  function buildElementXml(element, tags) {
    const header = attrsToString(element.attrs || {});
    const open = `<${element.type}${header ? ` ${header}` : ''}>`;
    const body = String(element.beforeTags || '').trimEnd();
    const tagLines = Object.keys(tags || {})
      .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }))
      .map((key) => `  <tag k="${escapeXml(key)}" v="${escapeXml(tags[key])}"/>`);
    const elementXml = [open, body, ...tagLines, `</${element.type}>`]
      .filter((line) => String(line || '').length > 0)
      .join('\n');
    return ['<osm version="0.6">', elementXml, '</osm>'].join('\n');
  }

  function parseGeneralSettingsRow(row: LooseRecord) {
    return {
      appDisplayName: row?.app_display_name ? String(row.app_display_name) : 'archimap',
      appBaseUrl: row?.app_base_url ? String(row.app_base_url) : ''
    };
  }

  async function readGeneralSettings() {
    if (appSettingsService?.getGeneralSettingsForAdmin) {
      try {
        const result = await appSettingsService.getGeneralSettingsForAdmin();
        return parseGeneralSettingsRow({
          app_display_name: result?.general?.appDisplayName,
          app_base_url: result?.general?.appBaseUrl
        });
      } catch {
        // fall back to DB/default
      }
    }
    try {
      const row = await db.prepare(`
        SELECT app_display_name, app_base_url
        FROM app_general_settings
        WHERE id = 1
        LIMIT 1
      `).get();
      return parseGeneralSettingsRow(row || {});
    } catch {
      return parseGeneralSettingsRow({});
    }
  }

  async function readSettingsRow() {
    try {
      return await db.prepare(`
        SELECT
          id,
          provider_name,
          auth_base_url,
          api_base_url,
          client_id,
          client_secret_enc,
          redirect_uri,
          access_token_enc,
          refresh_token_enc,
          token_type,
          scope,
          connected_user,
          connected_at,
          updated_by,
          updated_at
        FROM app_osm_settings
        WHERE id = 1
        LIMIT 1
      `).get() || null;
    } catch {
      return null;
    }
  }

  function normalizeStoredSettings(row: LooseRecord, generalBaseUrl = '') {
    const authBaseUrl = normalizeAuthBaseUrl(row?.auth_base_url || DEFAULT_AUTH_BASE_URL);
    const apiBaseUrl = normalizeApiBaseUrl(row?.api_base_url || '', authBaseUrl);
    const redirectUri = normalizeRedirectUri(row?.redirect_uri || '', generalBaseUrl) || null;
    return {
      providerName: String(row?.provider_name || 'OpenStreetMap'),
      authBaseUrl,
      apiBaseUrl,
      clientId: row?.client_id ? String(row.client_id) : null,
      hasClientSecret: Boolean(decryptSecret(row?.client_secret_enc)),
      redirectUri,
      hasAccessToken: Boolean(decryptSecret(row?.access_token_enc)),
      hasRefreshToken: Boolean(decryptSecret(row?.refresh_token_enc)),
      tokenType: row?.token_type ? String(row.token_type) : null,
      scope: row?.scope ? String(row.scope) : null,
      connectedUser: row?.connected_user ? String(row.connected_user) : null,
      connectedAt: row?.connected_at ? String(row.connected_at) : null,
      updatedBy: row?.updated_by ? String(row.updated_by) : null,
      updatedAt: row?.updated_at ? String(row.updated_at) : null
    };
  }
  async function saveSettings(input: LooseRecord = {}, actor = null) {
    const general = await readGeneralSettings();
    const current = await readSettingsRow();
    const currentNormalized = normalizeStoredSettings(current, general.appBaseUrl || '');
    const authBaseUrl = normalizeAuthBaseUrl(input.authBaseUrl || currentNormalized.authBaseUrl || DEFAULT_AUTH_BASE_URL);
    const currentApiBaseUrl = String(current?.api_base_url || '').trim();
    const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl || currentApiBaseUrl || '', authBaseUrl);
    const redirectUri = normalizeRedirectUri(input.redirectUri || currentNormalized.redirectUri || '', general.appBaseUrl || '');
    const clientId = normalizeText(input.clientId, 160);
    const providerName = normalizeText(input.providerName, 80) || 'OpenStreetMap';
    const clientSecretInput = Object.prototype.hasOwnProperty.call(input, 'clientSecret') ? String(input.clientSecret || '').trim() : null;
    const nextClientSecretEnc = clientSecretInput != null
      ? (clientSecretInput ? encryptSecret(clientSecretInput) : null)
      : current?.client_secret_enc || null;

    await db.prepare(`
      INSERT INTO app_osm_settings (
        id,
        provider_name,
        auth_base_url,
        api_base_url,
        client_id,
        client_secret_enc,
        redirect_uri,
        access_token_enc,
        refresh_token_enc,
        token_type,
        scope,
        connected_user,
        connected_at,
        updated_by,
        updated_at
      )
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        provider_name = excluded.provider_name,
        auth_base_url = excluded.auth_base_url,
        api_base_url = excluded.api_base_url,
        client_id = excluded.client_id,
        client_secret_enc = excluded.client_secret_enc,
        redirect_uri = excluded.redirect_uri,
        access_token_enc = excluded.access_token_enc,
        refresh_token_enc = excluded.refresh_token_enc,
        token_type = excluded.token_type,
        scope = excluded.scope,
        connected_user = excluded.connected_user,
        connected_at = excluded.connected_at,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(
      providerName,
      authBaseUrl,
      apiBaseUrl,
      clientId,
      nextClientSecretEnc,
      redirectUri,
      current?.access_token_enc || null,
      current?.refresh_token_enc || null,
      current?.token_type || null,
      current?.scope || null,
      current?.connected_user || null,
      current?.connected_at || null,
      normalizeText(actor, 160)
    );

    return getSettingsForAdmin();
  }

  async function getCredentials() {
    const general = await readGeneralSettings();
    const row = await readSettingsRow();
    const normalized = normalizeStoredSettings(row, general.appBaseUrl || '');
    return {
      settings: normalized,
      clientSecret: decryptSecret(row?.client_secret_enc),
      accessToken: decryptSecret(row?.access_token_enc),
      refreshToken: decryptSecret(row?.refresh_token_enc),
      redirectUri: normalized.redirectUri,
      authBaseUrl: normalized.authBaseUrl,
      apiBaseUrl: normalized.apiBaseUrl
    };
  }

  async function getSettingsForAdmin() {
    const general = await readGeneralSettings();
    const row = await readSettingsRow();
    const settings = normalizeStoredSettings(row, general.appBaseUrl || '');
    return {
      source: row ? 'db' : 'default',
      osm: settings,
      oauth: {
        canConnect: Boolean(settings.clientId && settings.redirectUri && settings.hasClientSecret),
        authBaseUrl: settings.authBaseUrl,
        apiBaseUrl: settings.apiBaseUrl,
        redirectUri: settings.redirectUri || normalizeRedirectUri('', general.appBaseUrl || '')
      }
    };
  }

  async function createOauthState(requestedBy = null) {
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(64).toString('base64url');
    const expiresAt = new Date(Date.now() + (20 * 60 * 1000)).toISOString();
    await db.prepare(`
      INSERT INTO app_osm_oauth_states (state, code_verifier, created_by, created_at, expires_at)
      VALUES (?, ?, ?, datetime('now'), ?)
    `).run(state, verifier, normalizeText(requestedBy, 160), expiresAt);
    return { state, verifier, expiresAt };
  }

  async function consumeOauthState(state) {
    const rawState = String(state || '').trim();
    if (!rawState) return null;
    const row = await db.prepare(`
      SELECT state, code_verifier, created_by, created_at, expires_at
      FROM app_osm_oauth_states
      WHERE state = ?
      LIMIT 1
    `).get(rawState);
    if (!row) return null;
    const expiresAt = Date.parse(String(row.expires_at || ''));
    await db.prepare('DELETE FROM app_osm_oauth_states WHERE state = ?').run(rawState);
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) return null;
    return {
      state: String(row.state),
      verifier: String(row.code_verifier || ''),
      createdBy: row.created_by ? String(row.created_by) : null,
      createdAt: row.created_at ? String(row.created_at) : null,
      expiresAt: row.expires_at ? String(row.expires_at) : null
    };
  }

  async function startOAuth(requestedBy = null) {
    const creds = await getCredentials();
    if (!creds.settings.clientId) {
      throw makeOsmError('OSM client id is not configured', {
        status: 503,
        code: 'OSM_SYNC_CLIENT_ID_MISSING'
      });
    }
    if (!creds.clientSecret) {
      throw makeOsmError('OSM client secret is not configured', {
        status: 503,
        code: 'OSM_SYNC_CLIENT_SECRET_MISSING'
      });
    }
    if (!creds.redirectUri) {
      throw makeOsmError('OSM redirect URI is not configured', {
        status: 503,
        code: 'OSM_SYNC_REDIRECT_URI_MISSING'
      });
    }
    const stateRow = await createOauthState(requestedBy);
    const challenge = await createPkceChallenge(stateRow.verifier);
    const authorizeUrl = new URL('/oauth2/authorize', creds.authBaseUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', creds.settings.clientId);
    authorizeUrl.searchParams.set('redirect_uri', creds.redirectUri);
    authorizeUrl.searchParams.set('scope', DEFAULT_SCOPE);
    authorizeUrl.searchParams.set('state', stateRow.state);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    return {
      state: stateRow.state,
      authorizeUrl: authorizeUrl.toString(),
      redirectUri: creds.redirectUri,
      authBaseUrl: creds.authBaseUrl,
      apiBaseUrl: creds.apiBaseUrl
    };
  }

  async function fetchText(url, init: LooseRecord = {}) {
    const response = await fetch(url, init);
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(text || `OSM request failed (${response.status})`) as LooseOsmError;
      error.status = response.status;
      error.code = `OSM_HTTP_${response.status}`;
      throw error;
    }
    return text;
  }

  async function exchangeCodeForToken({ code, verifier, authBaseUrl, redirectUri, clientId, clientSecret }: LooseRecord) {
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', String(code || ''));
    body.set('client_id', String(clientId || ''));
    body.set('redirect_uri', String(redirectUri || ''));
    body.set('code_verifier', String(verifier || ''));
    if (clientSecret) body.set('client_secret', String(clientSecret));
    const response = await fetch(new URL('/oauth2/token', authBaseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body
    });
    const text = await response.text();
    let payload: LooseRecord;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    if (!response.ok) {
      const error = new Error(String(payload?.error_description || payload?.error || text || `OSM token exchange failed (${response.status})`)) as LooseOsmError;
      error.status = response.status;
      error.code = payload?.error || `OSM_TOKEN_HTTP_${response.status}`;
      throw error;
    }
    return payload;
  }

  async function fetchOsmUserDetails(accessToken, apiBaseUrl) {
    try {
      const xml = await fetchText(new URL('/api/0.6/user/details', apiBaseUrl), {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/xml, text/xml;q=0.9, */*;q=0.1' }
      });
      const match = String(xml || '').match(/<user\b([^>]*)>/i);
      if (!match) return null;
      const attrs: LooseRecord = attrsToObject(match[1]);
      return attrs.display_name || attrs.name || attrs.username || null;
    } catch {
      return null;
    }
  }

  async function storeTokenBundle(bundle: LooseRecord, actor = null) {
    const current = await readSettingsRow();
    const general = await readGeneralSettings();
    const normalized = normalizeStoredSettings(current, general.appBaseUrl || '');
    await db.prepare(`
      INSERT INTO app_osm_settings (
        id,
        provider_name,
        auth_base_url,
        api_base_url,
        client_id,
        client_secret_enc,
        redirect_uri,
        access_token_enc,
        refresh_token_enc,
        token_type,
        scope,
        connected_user,
        connected_at,
        updated_by,
        updated_at
      )
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        provider_name = excluded.provider_name,
        auth_base_url = excluded.auth_base_url,
        api_base_url = excluded.api_base_url,
        client_id = excluded.client_id,
        client_secret_enc = excluded.client_secret_enc,
        redirect_uri = excluded.redirect_uri,
        access_token_enc = excluded.access_token_enc,
        refresh_token_enc = excluded.refresh_token_enc,
        token_type = excluded.token_type,
        scope = excluded.scope,
        connected_user = excluded.connected_user,
        connected_at = excluded.connected_at,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(
      normalized.providerName || 'OpenStreetMap',
      normalized.authBaseUrl,
      normalized.apiBaseUrl,
      normalized.clientId,
      current?.client_secret_enc || null,
      normalized.redirectUri,
      bundle?.access_token ? encryptSecret(bundle.access_token) : null,
      bundle?.refresh_token ? encryptSecret(bundle.refresh_token) : null,
      bundle?.token_type ? String(bundle.token_type) : null,
      bundle?.scope ? String(bundle.scope) : null,
      bundle?.connected_user ? String(bundle.connected_user) : null,
      bundle?.connected_at || new Date().toISOString(),
      normalizeText(actor, 160)
    );
    return getSettingsForAdmin();
  }

  async function handleOauthCallback({ code, state }: LooseRecord) {
    const creds = await getCredentials();
    const oauthState = await consumeOauthState(state);
    if (!oauthState) {
      const error = new Error('OAuth state is invalid or expired') as LooseOsmError;
      error.status = 400;
      error.code = 'OSM_OAUTH_STATE_INVALID';
      throw error;
    }
    if (!code) {
      const error = new Error('OAuth code is missing') as LooseOsmError;
      error.status = 400;
      error.code = 'OSM_OAUTH_CODE_MISSING';
      throw error;
    }
    const token = await exchangeCodeForToken({
      code,
      verifier: oauthState.verifier,
      authBaseUrl: creds.authBaseUrl,
      redirectUri: creds.redirectUri,
      clientId: creds.settings.clientId,
      clientSecret: creds.clientSecret
    });
    const connectedUser = await fetchOsmUserDetails(token.access_token, creds.apiBaseUrl);
    return storeTokenBundle({
      access_token: token.access_token,
      refresh_token: token.refresh_token || null,
      token_type: token.token_type || null,
      scope: token.scope || DEFAULT_SCOPE,
      connected_user: connectedUser
    }, oauthState.createdBy || 'admin');
  }

  async function readCandidateRows(osmType, osmId) {
    return await db.prepare(`
      SELECT
        ue.id,
        ue.osm_type,
        ue.osm_id,
        ue.created_by,
        ue.status,
        ue.edited_fields_json,
        ue.source_osm_version,
        ue.sync_status,
        ue.sync_attempted_at,
        ue.sync_succeeded_at,
        ue.sync_cleaned_at,
        ue.sync_changeset_id,
        ue.sync_summary_json,
        ue.sync_error_text,
        ue.source_tags_json,
        ue.source_osm_updated_at,
        ue.updated_at,
        ue.created_at,
        ai.name AS local_name,
        ai.style AS local_style,
        ai.design AS local_design,
        ai.design_ref AS local_design_ref,
        ai.design_year AS local_design_year,
        ai.material AS local_material,
        ai.material_concrete AS local_material_concrete,
        ai.colour AS local_colour,
        ai.levels AS local_levels,
        ai.year_built AS local_year_built,
        ai.architect AS local_architect,
        ai.address AS local_address,
        ai.description AS local_description,
        ai.archimap_description AS local_archimap_description,
        ai.updated_at AS local_updated_at,
        bc.tags_json AS contour_tags_json,
        bc.updated_at AS contour_updated_at
      FROM user_edits.building_user_edits ue
      LEFT JOIN local.architectural_info ai
        ON ai.osm_type = ue.osm_type AND ai.osm_id = ue.osm_id
      LEFT JOIN osm.building_contours bc
        ON bc.osm_type = ue.osm_type AND bc.osm_id = ue.osm_id
      WHERE ue.osm_type = ? AND ue.osm_id = ?
      ORDER BY ue.updated_at DESC, ue.id DESC
    `).all(osmType, osmId);
  }

  function parseEditedFields(raw) {
    const parsed = parseJson(raw, []);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => String(value || '').trim()).filter(Boolean);
  }

  function cloneTagMap(tags: LooseRecord = {}) {
    return Object.keys(tags || {}).reduce((acc, key) => {
      acc[key] = tags[key];
      return acc;
    }, {});
  }

  function normalizeStateValue(value) {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
    const text = String(value).trim();
    return text ? text : null;
  }

  function normalizeMaterialValue(material, materialConcrete = null) {
    const normalized = normalizeStateValue(material);
    const concrete = normalizeStateValue(materialConcrete);
    if (!normalized) return null;
    if (normalized === 'concrete' && concrete) return `concrete_${concrete}`;
    return normalized;
  }

  function stateFromLocalRow(row: LooseRecord = {}) {
    return {
      name: normalizeStateValue(row.local_name),
      style: normalizeStateValue(row.local_style),
      design: normalizeStateValue(row.local_design),
      design_ref: normalizeStateValue(row.local_design_ref),
      design_year: normalizeStateValue(row.local_design_year),
      material: normalizeMaterialValue(row.local_material, row.local_material_concrete),
      colour: normalizeStateValue(row.local_colour),
      levels: normalizeStateValue(row.local_levels),
      year_built: normalizeStateValue(row.local_year_built),
      architect: normalizeStateValue(row.local_architect),
      address: normalizeStateValue(row.local_address),
      description: normalizeStateValue(row.local_archimap_description || row.local_description)
    };
  }

  function stateFromContourTags(tags: LooseRecord = {}) {
    return {
      name: normalizeStateValue(tags.name),
      style: normalizeStateValue(tags['building:architecture'] || tags.architecture || tags.style),
      design: normalizeStateValue(tags.design),
      design_ref: normalizeStateValue(tags['design:ref'] || tags.design_ref),
      design_year: normalizeStateValue(tags['design:year'] || tags.design_year),
      material: normalizeMaterialValue(tags['building:material'] || tags.material),
      colour: normalizeStateValue(tags['building:colour'] || tags.colour),
      levels: normalizeStateValue(tags['building:levels'] || tags.levels),
      year_built: normalizeStateValue(tags['building:year'] || tags.start_date || tags.construction_date || tags.year_built),
      architect: normalizeStateValue(tags.architect || tags.architect_name),
      address: normalizeStateValue(tags['addr:full'] || tags['addr:full:en']),
      description: normalizeStateValue(tags.description)
    };
  }

  function diffStates(before: LooseRecord = {}, after: LooseRecord = {}) {
    const changed = [];
    const keys = ['name', 'style', 'design', 'design_ref', 'design_year', 'material', 'colour', 'levels', 'year_built', 'architect', 'address', 'description'];
    for (const key of keys) {
      if (before[key] !== after[key]) {
        changed.push({ key, before: before[key] ?? null, after: after[key] ?? null });
      }
    }
    return changed;
  }

  function buildChangesetComment(syncItems = []) {
    const items = Array.isArray(syncItems) ? syncItems.filter(Boolean) : [syncItems].filter(Boolean);
    if (items.length === 0) {
      return 'Update architectural info: OSM sync';
    }

    const fieldCount = items.reduce((total, item) => total + Number(item?.fieldCount ?? item?.summaryBase?.fieldCount ?? item?.diffKeys?.size ?? 0), 0);
    const labels = items
      .slice(0, 3)
      .map((item) => {
        const candidate = item?.candidate || {};
        const label = candidate?.latestLocalName
          || item?.localState?.name
          || (candidate?.osmType && candidate?.osmId ? `${candidate.osmType}/${candidate.osmId}` : null);
        return normalizeText(label, 64);
      })
      .filter(Boolean);

    let subject;
    if (items.length === 1) {
      const candidate = items[0]?.candidate || {};
      subject = labels[0]
        || (candidate?.osmType && candidate?.osmId ? `${candidate.osmType}/${candidate.osmId}` : null)
        || 'OSM building';
    } else {
      subject = `${items.length} buildings`;
      if (labels.length > 0) {
        subject += `: ${labels.join(', ')}${items.length > labels.length ? ` +${items.length - labels.length} more` : ''}`;
      }
    }

    return normalizeText(`Update architectural info: ${subject} (${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'})`, 255)
      || 'Update architectural info: OSM sync';
  }

  function buildChangesetTags(syncItems = [], _actor = null) {
    const items = Array.isArray(syncItems) ? syncItems.filter(Boolean) : [syncItems].filter(Boolean);
    const generalAppName = 'archimap';
    const source = normalizeText(DEFAULT_CHANGESET_SOURCE, 255) || DEFAULT_CHANGESET_SOURCE;
    const createdBy = normalizeText(DEFAULT_CHANGESET_CREATED_BY, 255) || DEFAULT_CHANGESET_CREATED_BY;
    const comment = buildChangesetComment(items);
    const sourceLabel = items.length === 1
      ? (
          items[0]?.candidate?.latestLocalName
          || items[0]?.localState?.name
          || (items[0]?.candidate?.osmType && items[0]?.candidate?.osmId ? `${items[0].candidate.osmType}/${items[0].candidate.osmId}` : null)
        )
      : `${items.length} buildings`;
    const tags = {
      comment,
      source: sourceLabel ? `${source} · ${sourceLabel}` : source,
      created_by: createdBy,
      generated_by: generalAppName
    };
    return Object.fromEntries(Object.entries(tags).filter(([, value]) => value != null && String(value).trim() !== ''));
  }

  function controlledKeysForField(field) {
    switch (field) {
      case 'name':
        return ['name', 'name:ru', 'official_name'];
      case 'style':
        return ['building:architecture', 'architecture', 'style'];
      case 'design':
        return ['design'];
      case 'design_ref':
        return ['design:ref', 'design_ref'];
      case 'design_year':
        return ['design:year', 'design_year'];
      case 'material':
        return ['building:material', 'material', 'building:material:concrete', 'material_concrete'];
      case 'colour':
        return ['building:colour', 'colour'];
      case 'levels':
        return ['building:levels', 'levels'];
      case 'year_built':
        return ['building:year', 'start_date', 'construction_date', 'year_built'];
      case 'architect':
        return ['architect', 'architect_name'];
      case 'address':
        return ['addr:full', 'addr:full:en'];
      case 'description':
        return ['description'];
      default:
        return [];
    }
  }

  function applyFieldToTagMap(tags: LooseRecord, field, value, explicitlyEdited = false) {
    const normalized = normalizeStateValue(value);
    const keys = controlledKeysForField(field);
    if (keys.length === 0) return;
    if (normalized == null) {
      if (!explicitlyEdited) return;
      const removedKeys = [];
      for (const key of keys) delete tags[key];
      removedKeys.push(...keys);
      return removedKeys;
    }

    switch (field) {
      case 'name':
        tags.name = normalized;
        return [];
      case 'style':
        tags['building:architecture'] = normalized;
        delete tags.architecture;
        delete tags.style;
        return ['architecture', 'style'];
      case 'design':
        tags.design = normalized;
        return [];
      case 'design_ref':
        tags['design:ref'] = normalized;
        delete tags.design_ref;
        return [];
      case 'design_year':
        tags['design:year'] = normalized;
        delete tags.design_year;
        return [];
      case 'material':
        if (normalized.startsWith('concrete_')) {
          tags['building:material'] = 'concrete';
          tags['building:material:concrete'] = normalized.slice('concrete_'.length);
        } else {
          tags['building:material'] = normalized;
          delete tags['building:material:concrete'];
        }
        delete tags.material;
        delete tags.material_concrete;
        return ['material', 'material_concrete'];
      case 'colour':
        tags['building:colour'] = normalized;
        tags.colour = normalized;
        return [];
      case 'levels':
        tags['building:levels'] = normalized;
        tags.levels = normalized;
        return [];
      case 'year_built':
        tags['building:year'] = normalized;
        return [];
      case 'architect':
        tags.architect = normalized;
        tags.architect_name = normalized;
        return [];
      case 'address':
        tags['addr:full'] = normalized;
        delete tags['addr:full:en'];
        return ['addr:full:en'];
      case 'description':
        tags.description = normalized;
        return [];
      default:
        return [];
    }
  }

  function buildDesiredTagMap(currentTags: LooseRecord, candidateRows) {
    const latestRow = candidateRows[0] || {};
    const desired = cloneTagMap(currentTags || {});
    const localState = stateFromLocalRow(latestRow);
    const explicitFields = new Set();
    const removedKeys = new Set();
    for (const row of candidateRows) {
      for (const field of parseEditedFields(row.edited_fields_json)) {
        explicitFields.add(field);
      }
    }

    for (const field of Object.keys(localState)) {
      const fieldRemovedKeys = applyFieldToTagMap(desired, field, localState[field], explicitFields.has(field));
      if (Array.isArray(fieldRemovedKeys)) {
        for (const key of fieldRemovedKeys) removedKeys.add(key);
      }
    }

    // Keep element metadata intact, but avoid accidental empty tags from blank values.
    for (const key of Object.keys(desired)) {
      if (desired[key] == null || String(desired[key]).trim() === '') {
        delete desired[key];
      }
    }

    return { desired: desired as LooseRecord, localState: localState as LooseRecord, explicitFields: [...explicitFields] as string[], removedKeys: [...removedKeys] as string[] };
  }

  function parseOsmElementResponse(xmlText) {
    const xml = String(xmlText || '').trim();
    const elementMatch = xml.match(/<\s*(node|way|relation)\b[\s\S]*?<\/\s*\1\s*>/i)
      || xml.match(/<\s*(node|way|relation)\b[^>]*\/>/i);
    if (!elementMatch) {
      throw new Error('Unexpected OSM element response');
    }
    const fragment = elementMatch[0];
    if (/\/>\s*$/.test(fragment)) {
      const header = fragment.replace(/^<\s*(node|way|relation)\b/i, '').replace(/\/>\s*$/, '');
      const type = String((fragment.match(/^<\s*(node|way|relation)\b/i) || [])[1] || '').toLowerCase();
      return {
        type,
        attrs: attrsToObject(header),
        beforeTags: '',
        tags: {},
        rawXml: fragment
      };
    }
    return parseElementXml(fragment);
  }

  async function fetchOsmElement(osmType, osmId, accessToken, apiBaseUrl) {
    const endpoint = new URL(`/api/0.6/${encodeURIComponent(osmType)}/${encodeURIComponent(osmId)}`, apiBaseUrl);
    const xml = await fetchText(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/xml, text/xml;q=0.9, */*;q=0.1'
      }
    });
    return parseOsmElementResponse(xml);
  }

  async function createChangeset(accessToken, apiBaseUrl, tags) {
    const xml = [
      '<osm>',
      '  <changeset>',
      ...Object.keys(tags).map((key) => `    <tag k="${escapeXml(key)}" v="${escapeXml(tags[key])}"/>`),
      '  </changeset>',
      '</osm>'
    ].join('\n');
    const response = await fetchText(new URL('/api/0.6/changeset/create', apiBaseUrl), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'text/xml; charset=utf-8',
        Accept: 'text/plain, */*;q=0.1'
      },
      body: xml
    });
    const changesetId = Number(String(response || '').trim());
    if (!Number.isInteger(changesetId) || changesetId <= 0) {
      throw new Error('OSM changeset create returned an invalid id');
    }
    return changesetId;
  }

  async function closeChangeset(accessToken, apiBaseUrl, changesetId) {
    await fetchText(new URL(`/api/0.6/changeset/${encodeURIComponent(changesetId)}/close`, apiBaseUrl), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'text/plain, */*;q=0.1'
      }
    });
  }

  function sanitizeElementAttrs(attrs: LooseRecord, elementType, changesetId) {
    const allowedKeys = new Set(['id', 'version', 'changeset', 'visible']);
    if (String(elementType || '').trim().toLowerCase() === 'node') {
      allowedKeys.add('lat');
      allowedKeys.add('lon');
    }
    const sanitized: LooseRecord = {};
    for (const key of allowedKeys) {
      if (attrs?.[key] != null) {
        sanitized[key] = String(attrs[key]);
      }
    }
    sanitized.id = String(attrs?.id || '');
    sanitized.version = String(attrs?.version || '');
    sanitized.changeset = String(changesetId);
    return sanitized;
  }

  async function updateOsmElement(accessToken, apiBaseUrl, currentElement, desiredTags, changesetId) {
    const elementAttrs: LooseRecord = currentElement.attrs || {};
    const attrs = sanitizeElementAttrs(elementAttrs, currentElement.type, changesetId);
    const bodyXml = buildElementXml({
      type: currentElement.type,
      attrs,
      beforeTags: currentElement.beforeTags
    }, desiredTags);
    return fetchText(new URL(`/api/0.6/${encodeURIComponent(currentElement.type)}/${encodeURIComponent(elementAttrs.id)}`, apiBaseUrl), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'text/xml; charset=utf-8',
        Accept: 'text/plain, */*;q=0.1'
      },
      body: bodyXml
    });
  }

  function parseSyncSummary(raw) {
    const parsed = parseJson(raw, null);
    return parsed && typeof parsed === 'object' ? parsed : null;
  }

  function buildCandidateRecord(rows: LooseRecord[]) {
    const latestRow: LooseRecord = rows[0] || {};
    const latestLocalState = stateFromLocalRow(latestRow);
    const contourState = stateFromContourTags(parseTags(latestRow?.contour_tags_json));
    const explicitFields = [...new Set(
      rows.flatMap((row) => parseEditedFields(row.edited_fields_json))
    )];
    const latestSyncStatus = rows.reduce((acc, row) => {
      const status = String(row.sync_status || 'unsynced');
      if (status === 'failed') return 'failed';
      if (status === 'syncing' && acc !== 'failed') return 'syncing';
      if (status === 'synced' && !['failed', 'syncing'].includes(acc)) return 'synced';
      if (status === 'cleaned' && !['failed', 'syncing', 'synced'].includes(acc)) return 'cleaned';
      return acc;
    }, 'unsynced');
    const syncReadOnly = latestSyncStatus === 'synced' || latestSyncStatus === 'cleaned';
    const summary = parseSyncSummary(latestRow?.sync_summary_json);
    const changes = diffStates(contourState, latestLocalState);
    const hasSyncableEdits = rows.some((row) => ['accepted', 'partially_accepted'].includes(String(row.status || '')));
    return {
      osmType: latestRow.osm_type,
      osmId: Number(latestRow.osm_id || 0),
      totalEdits: rows.length,
      syncableEdits: rows.filter((row) => ['accepted', 'partially_accepted'].includes(String(row.status || ''))).length,
      latestEditId: Number(latestRow.id || 0),
      latestUpdatedAt: latestRow.updated_at || null,
      latestCreatedBy: latestRow.created_by || null,
      latestStatus: latestRow.status || null,
      latestLocalName: latestRow.local_name || null,
      latestLocalUpdatedAt: latestRow.local_updated_at || null,
      sourceOsmUpdatedAt: latestRow.source_osm_updated_at || null,
      sourceOsmVersion: latestRow.source_osm_version || null,
      syncStatus: latestSyncStatus,
      syncAttemptedAt: latestRow.sync_attempted_at || null,
      syncSucceededAt: latestRow.sync_succeeded_at || null,
      syncCleanedAt: latestRow.sync_cleaned_at || null,
      syncChangesetId: latestRow.sync_changeset_id || null,
      syncSummary: summary,
      syncErrorText: latestRow.sync_error_text || null,
      currentContourUpdatedAt: latestRow.contour_updated_at || null,
      localState: latestLocalState,
      contourState,
      changes,
      syncReadOnly,
      canSync: hasSyncableEdits && !syncReadOnly && latestSyncStatus !== 'syncing',
      hasLocalState: Object.values(latestLocalState).some((value) => value != null),
      explicitFields
    };
  }

  async function listSyncCandidates(limit = 200) {
    const cap = Math.max(1, Math.min(500, Number(limit) || 200));
    const rows = await db.prepare(`
      SELECT
        ue.id,
        ue.osm_type,
        ue.osm_id,
        ue.created_by,
        ue.status,
        ue.edited_fields_json,
        ue.source_osm_version,
        ue.sync_status,
        ue.sync_attempted_at,
        ue.sync_succeeded_at,
        ue.sync_cleaned_at,
        ue.sync_changeset_id,
        ue.sync_summary_json,
        ue.sync_error_text,
        ue.source_tags_json,
        ue.source_osm_updated_at,
        ue.updated_at,
        ue.created_at,
        ai.name AS local_name,
        ai.style AS local_style,
        ai.design AS local_design,
        ai.design_ref AS local_design_ref,
        ai.design_year AS local_design_year,
        ai.material AS local_material,
        ai.material_concrete AS local_material_concrete,
        ai.colour AS local_colour,
        ai.levels AS local_levels,
        ai.year_built AS local_year_built,
        ai.architect AS local_architect,
        ai.address AS local_address,
        ai.description AS local_description,
        ai.archimap_description AS local_archimap_description,
        ai.updated_at AS local_updated_at,
        bc.tags_json AS contour_tags_json,
        bc.updated_at AS contour_updated_at
      FROM user_edits.building_user_edits ue
      LEFT JOIN local.architectural_info ai
        ON ai.osm_type = ue.osm_type AND ai.osm_id = ue.osm_id
      LEFT JOIN osm.building_contours bc
        ON bc.osm_type = ue.osm_type AND bc.osm_id = ue.osm_id
      WHERE ue.status IN ('accepted', 'partially_accepted')
      ORDER BY ue.updated_at DESC, ue.id DESC
      LIMIT ?
    `).all(cap);

    const grouped = new Map();
    for (const row of rows) {
      const key = `${row.osm_type}/${row.osm_id}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }

    return [...grouped.values()].map((group) => buildCandidateRecord(group));
  }

  async function getSyncCandidate(osmType, osmId) {
    const rows = await readCandidateRows(osmType, osmId);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const grouped = buildCandidateRecord(rows);
    const currentContour = parseTags(rows[0]?.contour_tags_json);
    let liveElement = null;
    let preflightError = null;

    try {
      const creds = await getCredentials();
      if (creds.accessToken) {
        liveElement = await fetchOsmElement(osmType, osmId, creds.accessToken, creds.apiBaseUrl);
      } else {
        preflightError = 'OSM access token is not connected';
      }
    } catch (error) {
      preflightError = String(error?.message || error);
    }

    const liveTagMap = liveElement ? Object.assign({}, liveElement.tags || {}) : {};
    const { desired, localState, explicitFields } = buildDesiredTagMap(liveTagMap, rows);
    const changedFields = diffStates(stateFromContourTags(liveTagMap), localState);
    const sourceFingerprint = tagsFingerprint(rows[0]?.source_tags_json || JSON.stringify(currentContour || {}));
    const liveFingerprint = liveElement ? JSON.stringify(stableJson(cloneTagMap(liveElement.tags || {}))) : null;
    const sourceMatches = liveFingerprint ? liveFingerprint === sourceFingerprint : false;

    return {
      ...grouped,
      currentContourUpdatedAt: rows[0]?.contour_updated_at || null,
      currentContourTags: currentContour,
      liveElement: liveElement ? {
        type: liveElement.type,
        attrs: liveElement.attrs,
        tags: liveElement.tags
      } : null,
      desiredTags: desired,
      localState,
      explicitFields,
      changedFields,
      sourceMatches,
      conflict: liveElement && !sourceMatches
        ? {
          type: 'upstream_drift',
          message: 'Live OSM state no longer matches the stored source snapshot',
          sourceFingerprint,
          liveFingerprint
        }
        : null,
      preflightError
    };
  }

  async function updateSyncRows(osmType, osmId, patch: LooseRecord, statuses = ['accepted', 'partially_accepted']) {
    const statusList = Array.isArray(statuses) && statuses.length > 0 ? statuses : ['accepted', 'partially_accepted'];
    const placeholders = statusList.map(() => '?').join(', ');
    await db.prepare(`
      UPDATE user_edits.building_user_edits
      SET
        sync_status = ?,
        sync_attempted_at = COALESCE(sync_attempted_at, datetime('now')),
        sync_succeeded_at = ?,
        sync_cleaned_at = ?,
        sync_changeset_id = ?,
        sync_summary_json = ?,
        sync_error_text = ?,
        updated_at = datetime('now')
      WHERE osm_type = ?
        AND osm_id = ?
        AND status IN (${placeholders})
    `).run(
      patch.syncStatus || null,
      patch.syncSucceededAt || null,
      patch.syncCleanedAt || null,
      patch.syncChangesetId || null,
      patch.syncSummaryJson || null,
      patch.syncErrorText || null,
      osmType,
      osmId,
      ...statusList
    );
  }

  async function prepareSyncCandidateSyncData(osmType, osmId, candidate: LooseRecord = null) {
    const syncCandidate = candidate || await getSyncCandidate(osmType, osmId);
    if (!syncCandidate) {
      return null;
    }

    const rows = await readCandidateRows(osmType, osmId);
    const currentTags = syncCandidate.liveElement?.tags || {};
    const { desired, localState, removedKeys } = buildDesiredTagMap(currentTags, rows);
    const changedFields = diffStates(stateFromContourTags(currentTags), localState);
    const diffKeys = new Set(
      Object.keys(desired).filter((key) => String(currentTags[key] ?? '') !== String(desired[key] ?? ''))
    );
    for (const key of removedKeys) {
      if (currentTags[key] != null && String(currentTags[key]).trim() !== '') {
        diffKeys.add(key);
      }
    }

    return {
      candidate: syncCandidate,
      rows,
      currentTags,
      desiredTags: desired,
      localState,
      changedFields,
      diffKeys,
      summaryBase: {
        osmType,
        osmId,
        fieldCount: diffKeys.size,
        changedFields: [...diffKeys],
        sourceUpdatedAt: syncCandidate.sourceOsmUpdatedAt || null,
        sourceVersion: syncCandidate.sourceOsmVersion || null
      },
      noChange: diffKeys.size === 0
    };
  }

  async function syncCandidatesToOsm(targets, _actor = null) {
    const requestedTargets = Array.isArray(targets) ? targets : [targets];
    const normalizedTargets = [];
    const seen = new Set();
    for (const target of requestedTargets) {
      const osmType = String(target?.osmType || '').trim();
      const osmId = Number(target?.osmId);
      if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) continue;
      const key = `${osmType}/${osmId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalizedTargets.push({ osmType, osmId });
    }

    if (normalizedTargets.length === 0) {
      const error = new Error('No sync candidates were provided') as LooseOsmError;
      error.status = 400;
      error.code = 'OSM_SYNC_CANDIDATES_MISSING';
      throw error;
    }

    const creds = await getCredentials();
    if (!creds.accessToken) {
      const error = new Error('OSM access token is not configured') as LooseOsmError;
      error.status = 503;
      error.code = 'OSM_SYNC_NOT_CONNECTED';
      throw error;
    }

    const preparedItems = [];
    for (const target of normalizedTargets) {
      const candidate = await getSyncCandidate(target.osmType, target.osmId);
      if (!candidate) {
        const error = new Error('Sync candidate was not found') as LooseOsmError;
        error.status = 404;
        error.code = 'OSM_SYNC_CANDIDATE_NOT_FOUND';
        error.details = target;
        throw error;
      }
      if (candidate.syncReadOnly) {
        const error = new Error('This building group has already been synchronized and is now read-only') as LooseOsmError;
        error.status = 409;
        error.code = 'OSM_SYNC_ALREADY_PUBLISHED';
        error.details = target;
        throw error;
      }
      if (candidate.syncStatus === 'syncing') {
        const error = new Error('This building group is currently being synchronized') as LooseOsmError;
        error.status = 409;
        error.code = 'OSM_SYNC_IN_PROGRESS';
        error.details = target;
        throw error;
      }
      if (!candidate.canSync) {
        const error = new Error('No accepted local edits are available for sync') as LooseOsmError;
        error.status = 409;
        error.code = 'OSM_SYNC_NO_ACCEPTED_EDITS';
        error.details = target;
        throw error;
      }
      if (!candidate.liveElement) {
        const error = new Error(candidate.preflightError || 'Unable to load the current OSM element') as LooseOsmError;
        error.status = 404;
        error.code = 'OSM_SYNC_SOURCE_MISSING';
        error.details = target;
        throw error;
      }
      if (!candidate.sourceMatches) {
        const error = new Error('OSM element changed since the source snapshot was captured') as LooseOsmError;
        error.status = 409;
        error.code = 'OSM_SYNC_SOURCE_DRIFT';
        error.details = candidate.conflict || null;
        throw error;
      }

      const prepared = await prepareSyncCandidateSyncData(target.osmType, target.osmId, candidate);
      if (!prepared) {
        const error = new Error('Sync candidate was not found') as LooseOsmError;
        error.status = 404;
        error.code = 'OSM_SYNC_CANDIDATE_NOT_FOUND';
        error.details = target;
        throw error;
      }
      preparedItems.push(prepared);
    }

    const noChangeItems = preparedItems.filter((item) => item.noChange);
    const actionableItems = preparedItems.filter((item) => !item.noChange);
    const noChangeResults = [];

    for (const item of noChangeItems) {
      const noChangeSummary = {
        ...item.summaryBase,
        syncedAt: new Date().toISOString(),
        noChange: true
      };
      await updateSyncRows(item.summaryBase.osmType, item.summaryBase.osmId, {
        syncStatus: 'synced',
        syncSucceededAt: noChangeSummary.syncedAt,
        syncCleanedAt: null,
        syncChangesetId: null,
        syncSummaryJson: JSON.stringify(noChangeSummary),
        syncErrorText: null
      });
      noChangeResults.push({
        osmType: item.summaryBase.osmType,
        osmId: item.summaryBase.osmId,
        noChange: true,
        summary: noChangeSummary
      });
    }

    const startedAt = new Date().toISOString();
    for (const item of actionableItems) {
      await updateSyncRows(item.summaryBase.osmType, item.summaryBase.osmId, {
        syncStatus: 'syncing',
        syncSucceededAt: null,
        syncCleanedAt: null,
        syncChangesetId: null,
        syncSummaryJson: JSON.stringify({
          ...item.summaryBase,
          localState: item.localState,
          changedFields: item.changedFields,
          startedAt
        }),
        syncErrorText: null
      });
    }

    if (actionableItems.length === 0) {
      return {
        ok: true,
        noChange: true,
        changesetId: null,
        items: noChangeResults,
        summary: {
          syncedAt: new Date().toISOString(),
          totalCount: preparedItems.length,
          noChangeCount: noChangeItems.length,
          syncedCount: 0,
          fieldCount: 0
        }
      };
    }

    const changesetTags = buildChangesetTags(actionableItems, _actor);
    const changesetId = await createChangeset(creds.accessToken, creds.apiBaseUrl, changesetTags);
    const syncedResults = [...noChangeResults];
    const syncedItemKeys = new Set();

    try {
      for (const item of actionableItems) {
        const syncedAt = new Date().toISOString();
        await updateOsmElement(creds.accessToken, creds.apiBaseUrl, item.candidate.liveElement, item.desiredTags, changesetId);
        syncedItemKeys.add(`${item.summaryBase.osmType}/${item.summaryBase.osmId}`);
        const summary = {
          ...item.summaryBase,
          changesetId,
          comment: changesetTags.comment || null,
          source: changesetTags.source || null,
          createdBy: changesetTags.created_by || null,
          batchSize: actionableItems.length,
          syncedAt
        };
        await updateSyncRows(item.summaryBase.osmType, item.summaryBase.osmId, {
          syncStatus: 'synced',
          syncSucceededAt: summary.syncedAt,
          syncCleanedAt: null,
          syncChangesetId: changesetId,
          syncSummaryJson: JSON.stringify(summary),
          syncErrorText: null
        });
        if (typeof enqueueSearchIndexRefresh === 'function') {
          enqueueSearchIndexRefresh(item.summaryBase.osmType, item.summaryBase.osmId);
        }
        await Promise.resolve(refreshDesignRefSuggestionsCache?.('osm-sync-publish'));
        syncedResults.push({
          osmType: item.summaryBase.osmType,
          osmId: item.summaryBase.osmId,
          noChange: false,
          changesetId,
          summary
        });
      }
    } catch (error) {
      const failureAt = new Date().toISOString();
      for (const item of actionableItems) {
        const key = `${item.summaryBase.osmType}/${item.summaryBase.osmId}`;
        if (syncedItemKeys.has(key)) continue;
        const failure = {
          ...item.summaryBase,
          changesetId,
          comment: changesetTags.comment || null,
          source: changesetTags.source || null,
          createdBy: changesetTags.created_by || null,
          batchSize: actionableItems.length,
          failedAt: failureAt,
          error: String(error?.message || error)
        };
        await updateSyncRows(item.summaryBase.osmType, item.summaryBase.osmId, {
          syncStatus: 'failed',
          syncSucceededAt: null,
          syncCleanedAt: null,
          syncChangesetId: null,
          syncSummaryJson: JSON.stringify(failure),
          syncErrorText: failure.error
        });
      }
      throw error;
    } finally {
      try {
        await closeChangeset(creds.accessToken, creds.apiBaseUrl, changesetId);
      } catch {
        // keep the main sync result; a close failure is noisy but not fatal here
      }
    }

    return {
      ok: true,
      noChange: false,
      changesetId,
      items: syncedResults,
      summary: {
        syncedAt: new Date().toISOString(),
        totalCount: preparedItems.length,
        noChangeCount: noChangeItems.length,
        syncedCount: actionableItems.length,
        fieldCount: actionableItems.reduce((total, item) => total + Number(item.summaryBase?.fieldCount || 0), 0)
      }
    };
  }

  async function syncCandidateToOsm(osmType, osmId, _actor = null) {
    const result = await syncCandidatesToOsm([{ osmType, osmId }], _actor);
    const item = Array.isArray(result.items) ? result.items[0] : null;
    if (!item) {
      return {
        ok: true,
        noChange: true,
        summary: result.summary || null
      };
    }
    return item.noChange
      ? {
          ok: true,
          noChange: true,
          summary: item.summary
        }
      : {
          ok: true,
          noChange: false,
          changesetId: result.changesetId,
          summary: item.summary
        };
  }

  async function cleanupSyncedLocalOverwritesAfterImport() {
    const candidates = await listSyncCandidates(500);
    const cleaned = [];

    for (const candidate of candidates) {
      if (!candidate || !['synced', 'cleaned'].includes(String(candidate.syncStatus || ''))) {
        continue;
      }
      if (!candidate.hasLocalState) continue;

      const contourRow = await db.prepare(`
        SELECT tags_json, updated_at
        FROM osm.building_contours
        WHERE osm_type = ? AND osm_id = ?
        LIMIT 1
      `).get(candidate.osmType, candidate.osmId);
      if (!contourRow) continue;

      const contourState = stateFromContourTags(parseTags(contourRow.tags_json));
      const localState = candidate.localState;
      const syncedFields = Array.isArray(candidate.explicitFields) && candidate.explicitFields.length > 0
        ? candidate.explicitFields
        : Object.keys(localState).filter((field) => field in localState);
      const sameState = syncedFields.every((field) => {
        if (!Object.prototype.hasOwnProperty.call(localState, field)) {
          return true;
        }
        return normalizeStateValue(contourState?.[field]) === normalizeStateValue(localState?.[field]);
      });
      if (!sameState) continue;

      const tx = db.transaction(() => {
        db.prepare(`
          DELETE FROM local.architectural_info
          WHERE osm_type = ? AND osm_id = ?
        `).run(candidate.osmType, candidate.osmId);

        db.prepare(`
          UPDATE user_edits.building_user_edits
          SET
            sync_status = 'cleaned',
            sync_cleaned_at = datetime('now'),
            updated_at = datetime('now')
          WHERE osm_type = ?
            AND osm_id = ?
            AND status IN ('accepted', 'partially_accepted')
            AND sync_status IN ('synced', 'cleaned')
        `).run(candidate.osmType, candidate.osmId);
      });

      try {
        tx();
        cleaned.push({
          osmType: candidate.osmType,
          osmId: candidate.osmId
        });
        if (typeof enqueueSearchIndexRefresh === 'function') {
          enqueueSearchIndexRefresh(candidate.osmType, candidate.osmId);
        }
        await Promise.resolve(refreshDesignRefSuggestionsCache?.('osm-sync-cleanup'));
      } catch (error) {
        // Continue cleaning other buildings if one fails.
        console.error('osm_sync_cleanup_failed', {
          osmType: candidate.osmType,
          osmId: candidate.osmId,
          error: String(error?.message || error)
        });
      }
    }

    return {
      ok: true,
      cleaned
    };
  }

  return {
    getSettingsForAdmin,
    saveSettings,
    startOAuth,
    handleOauthCallback,
    listSyncCandidates,
    getSyncCandidate,
    syncCandidatesToOsm,
    syncCandidateToOsm,
    cleanupSyncedLocalOverwritesAfterImport
  };
}

module.exports = {
  createOsmSyncService
};
