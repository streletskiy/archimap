CREATE TABLE IF NOT EXISTS osm.region_render_features (
  region_id BIGINT NOT NULL REFERENCES public.data_sync_regions(id) ON DELETE CASCADE,
  osm_type TEXT NOT NULL,
  osm_id BIGINT NOT NULL,
  feature_kind TEXT NOT NULL,
  source_osm_type TEXT NOT NULL,
  source_osm_id BIGINT NOT NULL,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  min_lon DOUBLE PRECISION NOT NULL,
  min_lat DOUBLE PRECISION NOT NULL,
  max_lon DOUBLE PRECISION NOT NULL,
  max_lat DOUBLE PRECISION NOT NULL,
  render_height_m DOUBLE PRECISION NOT NULL,
  render_min_height_m DOUBLE PRECISION NOT NULL,
  render_hide_base_when_parts SMALLINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (region_id, osm_type, osm_id, feature_kind)
);

CREATE INDEX IF NOT EXISTS idx_region_render_features_region_source
  ON osm.region_render_features (region_id, source_osm_type, source_osm_id);

CREATE INDEX IF NOT EXISTS idx_region_render_features_region_feature
  ON osm.region_render_features (region_id, feature_kind);

CREATE INDEX IF NOT EXISTS idx_region_render_features_geom_gist
  ON osm.region_render_features USING GIST (geom);
