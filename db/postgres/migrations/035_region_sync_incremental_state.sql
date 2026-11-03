CREATE SEQUENCE public.building_data_change_generation_seq;

CREATE TABLE public.building_data_changes (
  osm_type TEXT NOT NULL,
  osm_id BIGINT NOT NULL,
  generation BIGINT NOT NULL DEFAULT nextval('public.building_data_change_generation_seq'),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (osm_type, osm_id)
);

ALTER SEQUENCE public.building_data_change_generation_seq
  OWNED BY public.building_data_changes.generation;

-- A committed import stays dirty until its archive is successfully published.
-- One row per region also covers shared contours and parent/part remainders.
CREATE TABLE public.data_region_tile_state (
  region_id BIGINT PRIMARY KEY REFERENCES public.data_sync_regions(id) ON DELETE CASCADE,
  data_revision BIGINT NOT NULL DEFAULT 0,
  published_revision BIGINT NOT NULL DEFAULT -1,
  published_signature TEXT,
  published_archive_bytes BIGINT,
  published_archive_mtime_ms DOUBLE PRECISION
);

-- Compare source inputs conservatively: value changes may render identically,
-- but no height, floor-filter or feature-kind input may escape invalidation.
CREATE FUNCTION osm.region_tile_tag_inputs(tags_text TEXT)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE tags JSONB;
BEGIN
  tags := COALESCE(tags_text::jsonb, '{}'::jsonb);
  RETURN jsonb_build_array(
    tags -> 'building', tags -> 'building:part', tags -> 'building_part',
    tags -> 'building:levels', tags -> 'levels',
    tags -> 'building:height', tags -> 'height',
    tags -> 'building:min_level', tags -> 'min_level',
    tags -> 'building:min_height', tags -> 'min_height',
    -- The existing export classifier searches the serialized tag text.
    POSITION('"building"' IN COALESCE(tags_text, '')) > 0,
    POSITION('"building:part"' IN COALESCE(tags_text, '')) > 0,
    POSITION('"building_part"' IN COALESCE(tags_text, '')) > 0
  );
EXCEPTION WHEN invalid_text_representation THEN
  RETURN jsonb_build_array(tags_text);
END;
$$;

CREATE FUNCTION osm.track_building_insertions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.building_data_changes (osm_type, osm_id)
  SELECT osm_type, osm_id FROM inserted_contours ORDER BY osm_type, osm_id
  ON CONFLICT (osm_type, osm_id) DO UPDATE SET
    generation = nextval('public.building_data_change_generation_seq'), changed_at = NOW();

  INSERT INTO public.data_region_tile_state (region_id, data_revision)
  SELECT DISTINCT drm.region_id, 1
  FROM inserted_contours n
  JOIN public.data_region_memberships drm USING (osm_type, osm_id)
  ORDER BY drm.region_id
  ON CONFLICT (region_id) DO UPDATE SET data_revision = data_region_tile_state.data_revision + 1;
  RETURN NULL;
END;
$$;

CREATE FUNCTION osm.track_building_updates()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.building_data_changes (osm_type, osm_id)
  SELECT n.osm_type, n.osm_id
  FROM updated_contours n JOIN previous_contours o USING (osm_type, osm_id)
  WHERE ROW(n.tags_json, n.geom, n.min_lon, n.min_lat, n.max_lon, n.max_lat)
    IS DISTINCT FROM ROW(o.tags_json, o.geom, o.min_lon, o.min_lat, o.max_lon, o.max_lat)
  ORDER BY n.osm_type, n.osm_id
  ON CONFLICT (osm_type, osm_id) DO UPDATE SET
    generation = nextval('public.building_data_change_generation_seq'), changed_at = NOW();

  INSERT INTO public.data_region_tile_state (region_id, data_revision)
  SELECT DISTINCT drm.region_id, 1
  FROM updated_contours n JOIN previous_contours o USING (osm_type, osm_id)
  JOIN public.data_region_memberships drm USING (osm_type, osm_id)
  WHERE ROW(n.geom, n.min_lon, n.min_lat, n.max_lon, n.max_lat)
      IS DISTINCT FROM ROW(o.geom, o.min_lon, o.min_lat, o.max_lon, o.max_lat)
    OR (n.tags_json IS DISTINCT FROM o.tags_json AND
      osm.region_tile_tag_inputs(n.tags_json) IS DISTINCT FROM osm.region_tile_tag_inputs(o.tags_json))
  ORDER BY drm.region_id
  ON CONFLICT (region_id) DO UPDATE SET data_revision = data_region_tile_state.data_revision + 1;
  RETURN NULL;
END;
$$;

CREATE FUNCTION osm.track_building_deletions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.building_data_changes (osm_type, osm_id)
  SELECT osm_type, osm_id FROM deleted_contours ORDER BY osm_type, osm_id
  ON CONFLICT (osm_type, osm_id) DO UPDATE SET
    generation = nextval('public.building_data_change_generation_seq'), changed_at = NOW();

  INSERT INTO public.data_region_tile_state (region_id, data_revision)
  SELECT DISTINCT drm.region_id, 1
  FROM deleted_contours o JOIN public.data_region_memberships drm USING (osm_type, osm_id)
  ORDER BY drm.region_id
  ON CONFLICT (region_id) DO UPDATE SET data_revision = data_region_tile_state.data_revision + 1;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_building_contours_track_insert
AFTER INSERT ON osm.building_contours REFERENCING NEW TABLE AS inserted_contours
FOR EACH STATEMENT EXECUTE FUNCTION osm.track_building_insertions();
CREATE TRIGGER trg_building_contours_track_update
AFTER UPDATE ON osm.building_contours REFERENCING OLD TABLE AS previous_contours NEW TABLE AS updated_contours
FOR EACH STATEMENT EXECUTE FUNCTION osm.track_building_updates();
CREATE TRIGGER trg_building_contours_track_delete
AFTER DELETE ON osm.building_contours REFERENCING OLD TABLE AS deleted_contours
FOR EACH STATEMENT EXECUTE FUNCTION osm.track_building_deletions();

CREATE FUNCTION public.track_region_membership_changes()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.data_region_tile_state (region_id, data_revision)
  SELECT DISTINCT m.region_id, 1
  FROM changed_memberships m
  -- Cascaded region removal must not recreate its state row.
  JOIN public.data_sync_regions r ON r.id = m.region_id
  ORDER BY m.region_id
  ON CONFLICT (region_id) DO UPDATE SET data_revision = data_region_tile_state.data_revision + 1;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_region_memberships_track_insert
AFTER INSERT ON public.data_region_memberships REFERENCING NEW TABLE AS changed_memberships
FOR EACH STATEMENT EXECUTE FUNCTION public.track_region_membership_changes();
CREATE TRIGGER trg_region_memberships_track_delete
AFTER DELETE ON public.data_region_memberships REFERENCING OLD TABLE AS changed_memberships
FOR EACH STATEMENT EXECUTE FUNCTION public.track_region_membership_changes();
