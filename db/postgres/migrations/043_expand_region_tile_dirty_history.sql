-- Retain bounded spatial history until the tile planner can apply its own
-- budget. The input cap bounds work on very large transition tables.
ALTER TABLE public.data_region_tile_state
  DROP CONSTRAINT data_region_tile_state_dirty_bounds_check,
  ADD CONSTRAINT data_region_tile_state_dirty_bounds_check
    CHECK (jsonb_typeof(dirty_bounds) = 'array' AND jsonb_array_length(dirty_bounds) <= 20000);

CREATE OR REPLACE FUNCTION osm.append_region_tile_dirty_inputs(target_region BIGINT, inputs JSONB)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE current_state public.data_region_tile_state%ROWTYPE;
  incoming JSONB; combined JSONB;
BEGIN
  SELECT * INTO current_state FROM public.data_region_tile_state
    WHERE region_id = target_region FOR UPDATE;
  IF NOT FOUND OR current_state.full_rebuild_required THEN RETURN; END IF;
  IF jsonb_array_length(inputs) > 32768 OR EXISTS (
    SELECT 1 FROM jsonb_to_recordset(inputs) AS d(west FLOAT8, south FLOAT8, east FLOAT8, north FLOAT8,
      min_lon FLOAT8, min_lat FLOAT8, max_lon FLOAT8, max_lat FLOAT8)
    WHERE west IS NULL OR south IS NULL OR east IS NULL OR north IS NULL OR
      min_lon IS NULL OR min_lat IS NULL OR max_lon IS NULL OR max_lat IS NULL OR
      NOT (west BETWEEN -180 AND 180 AND east BETWEEN west AND 180 AND
        south BETWEEN -90 AND 90 AND north BETWEEN south AND 90)
  ) THEN
    UPDATE public.data_region_tile_state SET full_rebuild_required = true, dirty_bounds = '[]'
      WHERE region_id = target_region;
    RETURN;
  END IF;

  -- A changed part can alter a parent's hide flag over its entire footprint.
  -- Mirror the exporter containment rule, including its stored bounds. Old
  -- and new changed parents are already present in inputs themselves.
  WITH changed AS MATERIALIZED (
    SELECT DISTINCT * FROM jsonb_to_recordset(inputs) AS d(west FLOAT8, south FLOAT8, east FLOAT8, north FLOAT8,
      min_lon FLOAT8, min_lat FLOAT8, max_lon FLOAT8, max_lat FLOAT8, is_part BOOLEAN)
  ), candidates AS (
    SELECT jsonb_build_object('west', west, 'south', south, 'east', east, 'north', north) AS bounds FROM changed
    UNION ALL
    SELECT jsonb_build_object('west', ST_XMin(parent.geom), 'south', ST_YMin(parent.geom),
      'east', ST_XMax(parent.geom), 'north', ST_YMax(parent.geom))
    FROM changed part
    JOIN osm.building_contours parent ON part.is_part
      AND parent.geom && ST_MakeEnvelope(part.west, part.south, part.east, part.north, 4326)
      AND part.min_lon >= parent.min_lon AND part.max_lon <= parent.max_lon
      AND part.min_lat >= parent.min_lat AND part.max_lat <= parent.max_lat
    JOIN public.data_region_memberships drm
      ON drm.osm_type = parent.osm_type AND drm.osm_id = parent.osm_id AND drm.region_id = target_region
    WHERE POSITION('"building"' IN COALESCE(parent.tags_json, '')) > 0 OR
      (POSITION('"building:part"' IN COALESCE(parent.tags_json, '')) = 0 AND
       POSITION('"building_part"' IN COALESCE(parent.tags_json, '')) = 0)
  )
  SELECT COALESCE(jsonb_agg(bounds), '[]'::jsonb) INTO incoming
    FROM (SELECT bounds FROM candidates LIMIT 32769) bounded;

  IF jsonb_array_length(incoming) > 32768 THEN
    UPDATE public.data_region_tile_state SET full_rebuild_required = true, dirty_bounds = '[]'
      WHERE region_id = target_region;
    RETURN;
  END IF;
  -- Combine only envelopes whose corresponding corners occupy the same
  -- small geographic cells. The resulting box covers each input completely.
  SELECT COALESCE(jsonb_agg(to_jsonb(grouped)), '[]'::jsonb) INTO combined
  FROM (
    SELECT MIN(west) AS west, MIN(south) AS south, MAX(east) AS east, MAX(north) AS north
    FROM jsonb_to_recordset(current_state.dirty_bounds || incoming)
      AS d(west FLOAT8, south FLOAT8, east FLOAT8, north FLOAT8)
    GROUP BY floor(west * 512), floor(south * 512), floor(east * 512), floor(north * 512)
    LIMIT 20001
  ) grouped;
  UPDATE public.data_region_tile_state
    SET full_rebuild_required = jsonb_array_length(combined) > 20000,
        dirty_bounds = CASE WHEN jsonb_array_length(combined) > 20000 THEN '[]'::jsonb ELSE combined END
    WHERE region_id = target_region;
END;
$$;

CREATE OR REPLACE FUNCTION osm.track_region_tile_dirty_contours()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changes_sql TEXT; changed_condition TEXT; target_region BIGINT; inputs JSONB;
BEGIN
  -- Cold imports and regions already needing a full build do no spatial work.
  IF NOT EXISTS (SELECT 1 FROM public.data_region_tile_state WHERE NOT full_rebuild_required) THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    changes_sql := 'SELECT * FROM dirty_new_contours';
  ELSIF TG_OP = 'DELETE' THEN
    changes_sql := 'SELECT * FROM dirty_old_contours';
  ELSE
    -- Canonical identity rewrites are not the managed import path. Without an
    -- old/new identity correspondence they require complete invalidation.
    IF EXISTS (SELECT 1 FROM dirty_old_contours o FULL JOIN dirty_new_contours n USING (osm_type, osm_id)
      WHERE o.osm_id IS NULL OR n.osm_id IS NULL) THEN
      INSERT INTO public.data_region_tile_state (region_id, data_revision)
      SELECT DISTINCT drm.region_id, 1 FROM public.data_region_memberships drm
      JOIN (SELECT osm_type, osm_id FROM dirty_old_contours UNION SELECT osm_type, osm_id FROM dirty_new_contours) c
        USING (osm_type, osm_id)
      ORDER BY drm.region_id
      ON CONFLICT (region_id) DO UPDATE SET data_revision = data_region_tile_state.data_revision + 1,
        full_rebuild_required = true, dirty_bounds = '[]';
      RETURN NULL;
    END IF;
    changed_condition := 'ROW(n.geom,n.min_lon,n.min_lat,n.max_lon,n.max_lat) IS DISTINCT FROM
      ROW(o.geom,o.min_lon,o.min_lat,o.max_lon,o.max_lat) OR
      (n.tags_json IS DISTINCT FROM o.tags_json AND
       osm.region_tile_tag_inputs(n.tags_json) IS DISTINCT FROM osm.region_tile_tag_inputs(o.tags_json))';
    changes_sql := 'SELECT n.* FROM dirty_new_contours n JOIN dirty_old_contours o USING (osm_type,osm_id) WHERE ' || changed_condition ||
      ' UNION ALL SELECT o.* FROM dirty_new_contours n JOIN dirty_old_contours o USING (osm_type,osm_id) WHERE ' || changed_condition;
  END IF;
  FOR target_region IN EXECUTE 'SELECT DISTINCT drm.region_id FROM (' || changes_sql || ') c
    JOIN public.data_region_memberships drm USING (osm_type,osm_id)
    JOIN public.data_region_tile_state state ON state.region_id=drm.region_id
    WHERE NOT state.full_rebuild_required ORDER BY drm.region_id'
  LOOP
    EXECUTE 'SELECT COALESCE(jsonb_agg(input),''[]''::jsonb) FROM (
      SELECT osm.region_tile_dirty_input(c.tags_json,c.geom,c.min_lon,c.min_lat,c.max_lon,c.max_lat) AS input
      FROM (' || changes_sql || ') c JOIN public.data_region_memberships drm USING (osm_type,osm_id)
      WHERE drm.region_id=$1 LIMIT 32769) bounded' INTO inputs USING target_region;
    PERFORM osm.append_region_tile_dirty_inputs(target_region, inputs);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.track_region_tile_dirty_memberships()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changes_sql TEXT; target_region BIGINT; inputs JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN changes_sql := 'SELECT * FROM dirty_new_memberships';
  ELSIF TG_OP = 'DELETE' THEN changes_sql := 'SELECT * FROM dirty_old_memberships';
  ELSE
    changes_sql := '(SELECT * FROM dirty_new_memberships EXCEPT SELECT * FROM dirty_old_memberships)
      UNION ALL (SELECT * FROM dirty_old_memberships EXCEPT SELECT * FROM dirty_new_memberships)';
    -- Migration 035 covers INSERT/DELETE; also protect direct membership UPDATE.
    EXECUTE 'INSERT INTO public.data_region_tile_state (region_id,data_revision)
      SELECT DISTINCT m.region_id,1 FROM (' || changes_sql || ') m
      JOIN public.data_sync_regions r ON r.id=m.region_id ORDER BY m.region_id
      ON CONFLICT (region_id) DO UPDATE SET data_revision=data_region_tile_state.data_revision+1';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.data_region_tile_state WHERE NOT full_rebuild_required) THEN RETURN NULL; END IF;
  FOR target_region IN EXECUTE 'SELECT DISTINCT m.region_id FROM (' || changes_sql || ') m
    JOIN public.data_region_tile_state state USING (region_id)
    WHERE NOT state.full_rebuild_required ORDER BY m.region_id'
  LOOP
    EXECUTE 'SELECT COALESCE(jsonb_agg(input),''[]''::jsonb) FROM (
      SELECT osm.region_tile_dirty_input(bc.tags_json,bc.geom,bc.min_lon,bc.min_lat,bc.max_lon,bc.max_lat) AS input
      FROM (' || changes_sql || ') m LEFT JOIN osm.building_contours bc USING (osm_type,osm_id)
      WHERE m.region_id=$1 LIMIT 32769) bounded' INTO inputs USING target_region;
    PERFORM osm.append_region_tile_dirty_inputs(target_region, inputs);
  END LOOP;
  RETURN NULL;
END;
$$;
