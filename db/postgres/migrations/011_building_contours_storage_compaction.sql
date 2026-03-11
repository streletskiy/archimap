ALTER TABLE osm.building_contours
  ADD COLUMN IF NOT EXISTS building_levels_num DOUBLE PRECISION;

CREATE OR REPLACE FUNCTION osm.extract_building_levels_numeric(tags_text TEXT)
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  raw_value TEXT;
  normalized_value TEXT;
BEGIN
  BEGIN
    raw_value := jsonb_extract_path_text(tags_text::jsonb, 'building:levels');
  EXCEPTION
    WHEN others THEN
      RETURN NULL;
  END;

  IF raw_value IS NULL THEN
    RETURN NULL;
  END IF;

  normalized_value := replace(btrim(raw_value), ',', '.');
  IF normalized_value ~ '^-?\d+(?:\.\d+)?$' THEN
    RETURN normalized_value::double precision;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION osm.trg_sync_building_levels_num()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.building_levels_num := osm.extract_building_levels_numeric(NEW.tags_json);
  RETURN NEW;
END;
$$;

UPDATE osm.building_contours
SET building_levels_num = osm.extract_building_levels_numeric(tags_json)
WHERE building_levels_num IS NULL;

CREATE TABLE osm.building_contours_compact (
  osm_type TEXT NOT NULL,
  osm_id BIGINT NOT NULL,
  tags_json TEXT,
  min_lon DOUBLE PRECISION NOT NULL,
  min_lat DOUBLE PRECISION NOT NULL,
  max_lon DOUBLE PRECISION NOT NULL,
  max_lat DOUBLE PRECISION NOT NULL,
  geom geometry(MultiPolygon, 4326),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  building_levels_num DOUBLE PRECISION,
  PRIMARY KEY (osm_type, osm_id)
);

INSERT INTO osm.building_contours_compact (
  osm_type,
  osm_id,
  tags_json,
  min_lon,
  min_lat,
  max_lon,
  max_lat,
  geom,
  updated_at,
  building_levels_num
)
SELECT
  osm_type,
  osm_id,
  tags_json,
  min_lon,
  min_lat,
  max_lon,
  max_lat,
  CASE
    WHEN geom IS NOT NULL THEN ST_Multi(geom)
    ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(geometry_json), 4326))
  END AS geom,
  updated_at,
  COALESCE(building_levels_num, osm.extract_building_levels_numeric(tags_json)) AS building_levels_num
FROM osm.building_contours;

CREATE INDEX idx_building_contours_geom_gist_compact
  ON osm.building_contours_compact USING GIST (geom);

CREATE INDEX idx_building_contours_building_levels_num_compact
  ON osm.building_contours_compact USING BTREE (building_levels_num)
  WHERE building_levels_num IS NOT NULL;

DROP TABLE osm.building_contours;

ALTER TABLE osm.building_contours_compact RENAME TO building_contours;
ALTER TABLE osm.building_contours RENAME CONSTRAINT building_contours_compact_pkey TO building_contours_pkey;
ALTER INDEX osm.idx_building_contours_geom_gist_compact RENAME TO idx_building_contours_geom_gist;
ALTER INDEX osm.idx_building_contours_building_levels_num_compact RENAME TO idx_building_contours_building_levels_num;

DROP FUNCTION IF EXISTS osm.trg_sync_geom_from_geojson();

DROP TRIGGER IF EXISTS trg_building_contours_sync_building_levels_num ON osm.building_contours;
CREATE TRIGGER trg_building_contours_sync_building_levels_num
BEFORE INSERT OR UPDATE OF tags_json ON osm.building_contours
FOR EACH ROW
EXECUTE FUNCTION osm.trg_sync_building_levels_num();

ANALYZE osm.building_contours;
