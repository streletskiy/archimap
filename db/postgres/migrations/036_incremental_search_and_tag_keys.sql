-- Search keeps a single weighted vector, rather than a second copy of all tags.
ALTER TABLE public.building_search_source ALTER COLUMN search_tsv DROP EXPRESSION;
ALTER TABLE public.building_search_source DROP CONSTRAINT IF EXISTS building_search_source_searchable;

CREATE TABLE public.search_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  projection_version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.search_index_state (id) VALUES (1);

CREATE FUNCTION public.archimap_search_tags(raw_tags TEXT, local_info JSONB)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  doc JSONB;
  field_name TEXT;
  aliases JSONB;
  alias_name TEXT;
  field_value TEXT;
BEGIN
  BEGIN
    doc := COALESCE(raw_tags::jsonb, '{}'::jsonb);
    IF jsonb_typeof(doc) <> 'object' THEN doc := '{}'::jsonb; END IF;
  EXCEPTION WHEN invalid_text_representation THEN doc := '{}'::jsonb;
  END;
  FOR field_name, aliases IN SELECT * FROM jsonb_each('{
    "name":["name","name:ru","name:en","official_name"],
    "address":["address","addr:full"],
    "style":["style","building:architecture","architecture"],
    "architect":["architect","architect_name"],
    "design":["design"], "design_ref":["design_ref","design:ref"],
    "design_year":["design_year","design:year"],
    "material":["material","building:material"],
    "material_concrete":["material_concrete","building:material:concrete"],
    "roof_shape":["roof_shape","roof:shape","building:roof:shape"],
    "colour":["colour","building:colour"],
    "levels":["levels","building:levels"],
    "year_built":["year_built","building:year","start_date"],
    "archimap_description":["archimap_description","description"]
  }'::jsonb) LOOP
    field_value := NULLIF(btrim(local_info ->> field_name), '');
    IF field_name = 'archimap_description' THEN
      field_value := COALESCE(field_value, NULLIF(btrim(local_info ->> 'description'), ''));
    END IF;
    IF field_value IS NULL THEN CONTINUE; END IF;
    IF field_name = 'address' THEN
      SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO doc
      FROM jsonb_each(doc) WHERE key NOT LIKE 'addr:%';
    END IF;
    FOR alias_name IN SELECT jsonb_array_elements_text(aliases) LOOP
      IF doc ? alias_name OR alias_name = field_name THEN
        doc := jsonb_set(doc, ARRAY[alias_name], to_jsonb(field_value), true);
      END IF;
    END LOOP;
  END LOOP;
  RETURN doc;
END $$;

-- A local edit must survive a worker crash or an overlapping complete rebuild.
CREATE FUNCTION public.archimap_queue_local_search_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.building_data_changes (osm_type, osm_id)
  VALUES (COALESCE(NEW.osm_type, OLD.osm_type), COALESCE(NEW.osm_id, OLD.osm_id))
  ON CONFLICT (osm_type, osm_id) DO UPDATE SET
    generation = nextval('public.building_data_change_generation_seq'), changed_at = NOW();
  RETURN NULL;
END $$;
CREATE TRIGGER architectural_info_search_change AFTER INSERT OR UPDATE OR DELETE
ON local.architectural_info FOR EACH ROW EXECUTE FUNCTION public.archimap_queue_local_search_change();

CREATE FUNCTION public.archimap_filter_tag_keys(raw_tags TEXT) RETURNS TEXT[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE doc JSONB;
BEGIN
  BEGIN doc := raw_tags::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN RETURN ARRAY[]::text[]; END;
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' THEN RETURN ARRAY[]::text[]; END IF;
  RETURN ARRAY(SELECT DISTINCT left(btrim(key), 120) FROM jsonb_object_keys(doc) AS key
    WHERE btrim(key) <> '' ORDER BY 1);
END $$;

CREATE TABLE public.filter_tag_key_counts (
  tag_key TEXT PRIMARY KEY,
  feature_count BIGINT NOT NULL
);
INSERT INTO public.filter_tag_key_counts (tag_key, feature_count)
SELECT key, count(*) FROM osm.building_contours bc
CROSS JOIN LATERAL unnest(public.archimap_filter_tag_keys(bc.tags_json)) AS key GROUP BY key;
DELETE FROM public.filter_tag_keys_cache;
INSERT INTO public.filter_tag_keys_cache (tag_key, updated_at)
SELECT tag_key, NOW() FROM public.filter_tag_key_counts WHERE feature_count > 0;

-- Transition tables avoid one SQL update per building/tag during bulk imports.
CREATE FUNCTION public.archimap_update_filter_tag_counts() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE keys TEXT[]; deltas BIGINT[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(key ORDER BY key), array_agg(delta ORDER BY key) INTO keys, deltas
    FROM (SELECT key, count(*) AS delta FROM new_rows n
      CROSS JOIN LATERAL unnest(public.archimap_filter_tag_keys(n.tags_json)) AS key GROUP BY key) d;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(key ORDER BY key), array_agg(delta ORDER BY key) INTO keys, deltas
    FROM (SELECT key, -count(*) AS delta FROM old_rows o
      CROSS JOIN LATERAL unnest(public.archimap_filter_tag_keys(o.tags_json)) AS key GROUP BY key) d;
  ELSE
    SELECT array_agg(key ORDER BY key), array_agg(delta ORDER BY key) INTO keys, deltas
    FROM (SELECT key, sum(delta)::bigint AS delta FROM (
      SELECT key, 1 AS delta FROM new_rows n CROSS JOIN LATERAL unnest(public.archimap_filter_tag_keys(n.tags_json)) AS key
      UNION ALL
      SELECT key, -1 AS delta FROM old_rows o CROSS JOIN LATERAL unnest(public.archimap_filter_tag_keys(o.tags_json)) AS key
    ) changes GROUP BY key HAVING sum(delta) <> 0) d;
  END IF;
  IF keys IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.filter_tag_key_counts AS c (tag_key, feature_count)
  SELECT * FROM unnest(keys, deltas) ORDER BY 1
  ON CONFLICT (tag_key) DO UPDATE SET feature_count = c.feature_count + excluded.feature_count;
  INSERT INTO public.filter_tag_keys_cache (tag_key, updated_at)
  SELECT tag_key, NOW() FROM public.filter_tag_key_counts WHERE tag_key = ANY(keys) AND feature_count > 0
  ON CONFLICT (tag_key) DO UPDATE SET updated_at = excluded.updated_at;
  DELETE FROM public.filter_tag_keys_cache k USING public.filter_tag_key_counts c
    WHERE k.tag_key = c.tag_key AND c.tag_key = ANY(keys) AND c.feature_count <= 0;
  DELETE FROM public.filter_tag_key_counts WHERE tag_key = ANY(keys) AND feature_count <= 0;
  RETURN NULL;
END $$;
CREATE TRIGGER building_filter_tags_insert AFTER INSERT ON osm.building_contours
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.archimap_update_filter_tag_counts();
CREATE TRIGGER building_filter_tags_update AFTER UPDATE ON osm.building_contours
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.archimap_update_filter_tag_counts();
CREATE TRIGGER building_filter_tags_delete AFTER DELETE ON osm.building_contours
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.archimap_update_filter_tag_counts();
