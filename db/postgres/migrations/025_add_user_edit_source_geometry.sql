ALTER TABLE user_edits.building_user_edits
  ADD COLUMN IF NOT EXISTS source_geometry_json TEXT;

CREATE INDEX IF NOT EXISTS idx_user_building_edits_target
  ON user_edits.building_user_edits (osm_type, osm_id, updated_at DESC);
