DROP INDEX IF EXISTS local.idx_architectural_info_osm;

CREATE TABLE IF NOT EXISTS osm.building_contours_summary (
  singleton_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  total BIGINT NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO osm.building_contours_summary (singleton_id, total, last_updated, refreshed_at)
SELECT 1, COUNT(*)::bigint, MAX(updated_at), NOW()
FROM osm.building_contours
ON CONFLICT (singleton_id) DO UPDATE SET
  total = EXCLUDED.total,
  last_updated = EXCLUDED.last_updated,
  refreshed_at = EXCLUDED.refreshed_at;
