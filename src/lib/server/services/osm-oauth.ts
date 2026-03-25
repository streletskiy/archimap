import {
  DEFAULT_AUTH_BASE_URL,
  DEFAULT_SCOPE,
  decryptSecret,
  encryptSecret,
  makeOsmError,
  normalizeApiBaseUrl,
  normalizeAuthBaseUrl,
  normalizeRedirectUri,
  normalizeText,
  parseGeneralSettingsRow,
  createPkceChallenge
} from './osm-sync.shared';
import { exchangeCodeForToken, fetchOsmUserDetails } from './osm-api-client';

type OauthDeps = {
  db: any;
  settingsSecret: string;
  appSettingsService?: LooseRecord | null;
  fetch?: typeof fetch;
};

function createOsmOauthController(deps: OauthDeps) {
  const { db, settingsSecret, appSettingsService } = deps;
  if (!db) throw new Error('createOsmOauthController: db is required');
  const secret = String(settingsSecret || '').trim();
  if (!secret) throw new Error('createOsmOauthController: settingsSecret is required');

  const secretKey = require('crypto').scryptSync(secret, 'archimap:osm-sync-service', 32);

  function encrypt(value) {
    return encryptSecret(secretKey, value);
  }

  function decrypt(value) {
    return decryptSecret(secretKey, value);
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
      hasClientSecret: Boolean(decrypt(row?.client_secret_enc)),
      redirectUri,
      hasAccessToken: Boolean(decrypt(row?.access_token_enc)),
      hasRefreshToken: Boolean(decrypt(row?.refresh_token_enc)),
      tokenType: row?.token_type ? String(row.token_type) : null,
      scope: row?.scope ? String(row.scope) : null,
      connectedUser: row?.connected_user ? String(row.connected_user) : null,
      connectedAt: row?.connected_at ? String(row.connected_at) : null,
      updatedBy: row?.updated_by ? String(row.updated_by) : null,
      updatedAt: row?.updated_at ? String(row.updated_at) : null
    };
  }

  async function getCredentials() {
    const general = await readGeneralSettings();
    const row = await readSettingsRow();
    const normalized = normalizeStoredSettings(row, general.appBaseUrl || '');
    return {
      settings: normalized,
      clientSecret: decrypt(row?.client_secret_enc),
      accessToken: decrypt(row?.access_token_enc),
      refreshToken: decrypt(row?.refresh_token_enc),
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
      ? (clientSecretInput ? encrypt(clientSecretInput) : null)
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

  async function createOauthState(requestedBy = null) {
    const state = require('crypto').randomBytes(32).toString('base64url');
    const verifier = require('crypto').randomBytes(64).toString('base64url');
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
      bundle?.access_token ? encrypt(bundle.access_token) : null,
      bundle?.refresh_token ? encrypt(bundle.refresh_token) : null,
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
      const error = new Error('OAuth state is invalid or expired') as LooseRecord;
      error.status = 400;
      error.code = 'OSM_OAUTH_STATE_INVALID';
      throw error;
    }
    if (!code) {
      const error = new Error('OAuth code is missing') as LooseRecord;
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

  return {
    getSettingsForAdmin,
    saveSettings,
    startOAuth,
    handleOauthCallback,
    getCredentials
  };
}

export { createOsmOauthController };
