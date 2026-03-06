ALTER TABLE IF EXISTS user_edits.building_user_edits
  ADD COLUMN IF NOT EXISTS edited_fields_json TEXT;
