ALTER TABLE user_edits.building_user_edits
  ADD COLUMN IF NOT EXISTS source_tags_json TEXT;

ALTER TABLE user_edits.building_user_edits
  ADD COLUMN IF NOT EXISTS source_osm_updated_at TIMESTAMPTZ;
