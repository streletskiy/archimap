CREATE TABLE IF NOT EXISTS public.app_osm_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider_name TEXT NOT NULL DEFAULT 'OpenStreetMap',
  auth_base_url TEXT NOT NULL DEFAULT 'https://www.openstreetmap.org',
  api_base_url TEXT NOT NULL DEFAULT 'https://api.openstreetmap.org',
  client_id TEXT,
  client_secret_enc TEXT,
  redirect_uri TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_type TEXT,
  scope TEXT,
  connected_user TEXT,
  connected_at TIMESTAMPTZ,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.app_osm_oauth_states (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE user_edits.building_user_edits
  ADD COLUMN IF NOT EXISTS source_osm_version BIGINT;

ALTER TABLE user_edits.building_user_edits
  ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'unsynced';

ALTER TABLE user_edits.building_user_edits
  ADD COLUMN IF NOT EXISTS sync_attempted_at TIMESTAMPTZ;

ALTER TABLE user_edits.building_user_edits
  ADD COLUMN IF NOT EXISTS sync_succeeded_at TIMESTAMPTZ;

ALTER TABLE user_edits.building_user_edits
  ADD COLUMN IF NOT EXISTS sync_cleaned_at TIMESTAMPTZ;

ALTER TABLE user_edits.building_user_edits
  ADD COLUMN IF NOT EXISTS sync_changeset_id BIGINT;

ALTER TABLE user_edits.building_user_edits
  ADD COLUMN IF NOT EXISTS sync_summary_json TEXT;

ALTER TABLE user_edits.building_user_edits
  ADD COLUMN IF NOT EXISTS sync_error_text TEXT;

CREATE INDEX IF NOT EXISTS idx_user_building_edits_sync
  ON user_edits.building_user_edits (osm_type, osm_id, sync_status, updated_at DESC);
