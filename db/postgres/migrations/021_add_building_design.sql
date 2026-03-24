ALTER TABLE local.architectural_info
  ADD COLUMN IF NOT EXISTS design TEXT;

ALTER TABLE user_edits.building_user_edits
  ADD COLUMN IF NOT EXISTS design TEXT;
