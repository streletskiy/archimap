CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA IF NOT EXISTS osm;
CREATE SCHEMA IF NOT EXISTS local;
CREATE SCHEMA IF NOT EXISTS user_edits;
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS osm.building_contours (
  osm_type TEXT NOT NULL,
  osm_id BIGINT NOT NULL,
  tags_json TEXT,
  geometry_json TEXT NOT NULL,
  min_lon DOUBLE PRECISION NOT NULL,
  min_lat DOUBLE PRECISION NOT NULL,
  max_lon DOUBLE PRECISION NOT NULL,
  max_lat DOUBLE PRECISION NOT NULL,
  geom geometry(MultiPolygon, 4326),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (osm_type, osm_id)
);

CREATE INDEX IF NOT EXISTS idx_building_contours_bbox
  ON osm.building_contours (min_lon, max_lon, min_lat, max_lat);
CREATE INDEX IF NOT EXISTS idx_building_contours_geom_gist
  ON osm.building_contours USING GIST (geom);

UPDATE osm.building_contours
SET geom = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(geometry_json), 4326))
WHERE geom IS NULL
  AND geometry_json IS NOT NULL;

CREATE OR REPLACE FUNCTION osm.trg_sync_geom_from_geojson()
RETURNS trigger AS $$
BEGIN
  IF NEW.geometry_json IS NULL OR length(trim(NEW.geometry_json)) = 0 THEN
    NEW.geom := NULL;
  ELSE
    NEW.geom := ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(NEW.geometry_json), 4326));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_building_contours_sync_geom ON osm.building_contours;
CREATE TRIGGER trg_building_contours_sync_geom
BEFORE INSERT OR UPDATE OF geometry_json ON osm.building_contours
FOR EACH ROW
EXECUTE FUNCTION osm.trg_sync_geom_from_geojson();

CREATE TABLE IF NOT EXISTS public.building_search_source (
  osm_key TEXT PRIMARY KEY,
  osm_type TEXT NOT NULL,
  osm_id BIGINT NOT NULL,
  name TEXT,
  address TEXT,
  style TEXT,
  architect TEXT,
  design_ref TEXT,
  local_priority INTEGER NOT NULL DEFAULT 0,
  center_lon DOUBLE PRECISION NOT NULL,
  center_lat DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_building_search_source_osm
  ON public.building_search_source (osm_type, osm_id);

CREATE TABLE IF NOT EXISTS public.filter_tag_keys_cache (
  tag_key TEXT PRIMARY KEY,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.app_smtp_settings (
  id INTEGER PRIMARY KEY,
  smtp_url TEXT,
  smtp_host TEXT,
  smtp_port INTEGER NOT NULL DEFAULT 587,
  smtp_secure INTEGER NOT NULL DEFAULT 0,
  smtp_user TEXT,
  smtp_pass_enc TEXT,
  email_from TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_smtp_settings_singleton CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS public.app_general_settings (
  id INTEGER PRIMARY KEY,
  app_display_name TEXT NOT NULL DEFAULT 'archimap',
  app_base_url TEXT,
  registration_enabled INTEGER NOT NULL DEFAULT 1,
  user_edit_requires_permission INTEGER NOT NULL DEFAULT 1,
  metrics_token TEXT,
  basemap_provider TEXT NOT NULL DEFAULT 'carto',
  maptiler_api_key TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_general_settings_singleton CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS local.architectural_info (
  id BIGSERIAL PRIMARY KEY,
  osm_type TEXT NOT NULL,
  osm_id BIGINT NOT NULL,
  name TEXT,
  style TEXT,
  design TEXT,
  design_ref TEXT,
  design_year INTEGER,
  colour TEXT,
  levels INTEGER,
  year_built INTEGER,
  architect TEXT,
  address TEXT,
  description TEXT,
  archimap_description TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (osm_type, osm_id)
);

CREATE INDEX IF NOT EXISTS idx_architectural_info_osm
  ON local.architectural_info (osm_type, osm_id);

CREATE TABLE IF NOT EXISTS user_edits.building_user_edits (
  id BIGSERIAL PRIMARY KEY,
  osm_type TEXT NOT NULL,
  osm_id BIGINT NOT NULL,
  created_by TEXT NOT NULL,
  name TEXT,
  style TEXT,
  design TEXT,
  design_ref TEXT,
  design_year INTEGER,
  colour TEXT,
  levels INTEGER,
  year_built INTEGER,
  architect TEXT,
  address TEXT,
  archimap_description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_comment TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  merged_by TEXT,
  merged_at TIMESTAMPTZ,
  merged_fields_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_building_edits_lookup
  ON user_edits.building_user_edits (osm_type, osm_id, created_by, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_building_edits_author
  ON user_edits.building_user_edits (created_by, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_building_edits_status
  ON user_edits.building_user_edits (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS auth.users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  can_edit INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_master_admin INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth.email_registration_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  password_hash TEXT,
  first_name TEXT,
  last_name TEXT,
  verify_token_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_registration_codes_expires
  ON auth.email_registration_codes (expires_at);
CREATE INDEX IF NOT EXISTS idx_email_registration_codes_verify_token
  ON auth.email_registration_codes (verify_token_hash);

CREATE TABLE IF NOT EXISTS auth.password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  used_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email
  ON auth.password_reset_tokens (email);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires
  ON auth.password_reset_tokens (expires_at);
